# HDS — Heat Dissipation Simulator

**Status:** approved design, 2026-08-14
**Scope:** browser-based steady-state thermal simulator for CAD assemblies

---

## 1. Purpose

Load a CAD assembly, assign materials and thermal boundary conditions to its parts,
solve the steady-state temperature field, and read the result as a shaded 3D model
plus a set of analysis plots — including arbitrary cross-sections.

The reference output is `thermal_field.png`: a sheet-metal housing with a rim held at
200 °C in 20 °C still air, showing the surface field, a temperature-vs-path-length
scatter, a filled 2D field on a cut plane, and a profile along a cut line.

Everything runs client-side. No server, no upload of CAD data.

---

## 2. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Physics model | Shell conduction on the tessellated surface | Matches the sheet-metal use case; runs on the render mesh; no tet meshing needed in-browser |
| Volumetric solve | Deferred to a later phase, behind a solver interface | Keeps v1 interactive and shippable |
| Time domain | Steady-state only | Matches the reference; one linear solve per Picard iteration |
| Bulk parts | Per-part body type, auto-guessed | Shell-over-skin understates how bulk blocks short-circuit heat |
| Contacts | Auto-detect by proximity + manual override, finite conductance | CAD assemblies often have touching parts that shouldn't conduct |
| Convection | Natural-convection correlations, per-surface, with override | Orientation matters visibly on a housing |
| Loads | Fixed temperature *and* heat load in watts | Same matrix, just a source term |
| Cavities | Auto-detect inside-facing surfaces by ray casting + override | A closed housing loses far less heat than the raw surface area implies |
| Cut planes | Profile line + cheap 2D conduction solve on the plane | Reproduces both bottom plots without a 3D solve |
| Stack | Vite + TypeScript + React + three.js, Vitest | Panel-heavy UI; imperative render loop; solver testable without a browser |

---

## 3. Architecture

```
src/
  core/        types.ts — ThermalModel, Scenario, SolveResult (the shared contract)
               units.ts, ids.ts
  geometry/    importers/{step,stl,obj}.ts
               build.ts      raw tessellation → ThermalModel (weld, areas, adjacency)
               topology.ts   connected components, feature edges, face regions
               cavity.ts     inside/outside classification
               contacts.ts   proximity-based contact detection
               section.ts    plane × mesh → polylines with interpolated values
  physics/     materials.ts  library + property types
               convection.ts natural-convection correlations
               radiation.ts  linearised radiation coefficient
               assemble.ts   ThermalModel + Scenario → sparse system
               sparse.ts     CSR matrix, Jacobi-preconditioned CG
               solve.ts      Picard outer loop
               worker.ts     Web Worker entry point
  analysis/    pathLength.ts Dijkstra over the conduction graph + exponential fit
               balance.ts    heat balance per part and per mechanism
               slice2d.ts    2D conduction fill on a cut plane + marching squares
               threshold.ts  area-above-temperature statistics
  viewer/      scene.ts, picking.ts, colormap.ts, sectionGizmo.ts, overlays.ts
  ui/          panels + React state
  io/          project save/load
```

**Hard rule:** `physics/` and `analysis/` import neither three.js nor React. They take
typed arrays in and return typed arrays out. This is what makes the voxel backend a
drop-in replacement later, and what makes the solver unit-testable in Node.

---

## 4. Core data model

### ThermalModel — the output of import, the input to everything else

```ts
interface ThermalModel {
  nodes: Float32Array;        // welded positions, SI metres, xyz interleaved
  tris: Uint32Array;          // triangle indices into nodes
  triPart: Uint32Array;       // triangle → part index
  triFace: Uint32Array;       // triangle → face region index (B-rep face for STEP,
                              //   dihedral-derived region for STL/OBJ)
  triArea: Float32Array;      // SI m²
  triNormal: Float32Array;    // unit normals, xyz interleaved
  nodeArea: Float32Array;     // ⅓ of each incident triangle — the area each node
                              //   convects and radiates through
  nodePart: Uint32Array;      // node → owning part (nodes are not welded across parts)
  triCavity: Uint8Array;      // 0 = open air, else cavity id
  parts: Part[];
  featureEdges: EdgeChain[];  // for edge selection and display
  bbox: { min: Vec3; max: Vec3 };
  sourceUnits: 'mm' | 'm' | 'in';
}
```

### Vertex welding is load-bearing

Tessellators emit duplicated vertices at every face seam. Unwelded, an assembly is a
pile of thermally disconnected patches and heat goes nowhere. `build.ts` merges
coincident vertices **within a part** using a spatial hash, tolerance
`1e-6 × bbox diagonal`. Nodes are deliberately *not* welded across parts — inter-part
heat flow goes through explicit contacts so it can carry a finite conductance.

### Part

```ts
interface Part {
  id: string;            // stable: source name + ordinal
  name: string;          // from CAD ('housing', 'glava', ...)
  bodyType: 'sheet' | 'lump' | 'insulator';
  materialId: string;
  thickness: number;     // SI metres; used when bodyType === 'sheet'
  finishId: string;      // surface finish → emissivity, independent of material
  triRange: [number, number];
  volume: number;        // signed volume of the closed shell, for the bodyType guess
  surfaceArea: number;
}
```

`bodyType` is guessed on import from the *thinness ratio* `6·volume / (surfaceArea ·
bboxDiagonal)`. Thin shells score low and default to `sheet`; chunky solids score high
and default to `lump`. The guess is always visible and overridable in the part panel —
it is a starting point, not a hidden decision.

### nodeDof — how lump parts work

`nodeDof: Int32Array` maps each node to a solver degree of freedom. A `sheet` part maps
1:1. A `lump` part maps **every** node to a single shared DOF, making it internally
isothermal while still exchanging heat over its full surface area. An `insulator` part
maps to `-1` and is excluded from the system entirely.

This is the only place bulk parts are special-cased. Assembly, solve, and rendering are
unaware.

### Scenario — everything the user sets

```ts
interface Scenario {
  ambientC: number;
  gravity: Vec3;                    // for convection orientation, default (0,0,-1)
  partOverrides: Record<string, PartOverride>;
  boundaryConditions: BoundaryCondition[];
  contacts: Contact[];
  cavities: Cavity[];
  colorScale: { minC: number; maxC: number; mode: 'auto' | 'manual'; map: ColormapId };
}

type BoundaryCondition =
  | { kind: 'fixedTemp'; target: Target; valueC: number }
  | { kind: 'heatLoad';  target: Target; watts: number }
  | { kind: 'convection'; target: Target; h: number | 'auto' };

type Target =
  | { type: 'part'; partId: string }
  | { type: 'face'; partId: string; faceId: number }
  | { type: 'edge'; partId: string; edgeId: number }
  | { type: 'node'; partId: string; nodeId: number };
```

`Target` resolves to a node set. A `heatLoad` on a target distributes watts across its
nodes weighted by `nodeArea`. A `fixedTemp` on a target pins every node in it.

---

## 5. Physics

### Shell conduction

Linear triangle elements, cotangent Laplacian. For a triangle with vertices *i, j, k*,
the conductance contributed between *i* and *j* is:

```
G_ij = k · t · cot(θ_k) / 2
```

summed over all triangles sharing the edge. `k` is thermal conductivity (W/m·K), `t` is
thickness (m).

**Obtuse triangles produce negative cotangent weights**, which breaks diagonal dominance
and can yield non-physical local extrema. Negative weights are clamped to zero. This is
the standard robustness fix and is acceptable given the stated precision target; the
alternative (remeshing) is out of scope.

For `lump` parts, conduction within the part is implicit — all its nodes share a DOF.

### Convection

Per triangle, from the surface normal, the sign of ΔT, and a per-part characteristic
length. Air properties evaluated at film temperature `(T_s + T_amb)/2`.

- **Vertical** (`|n·g| < 0.34`) — Churchill–Chu:
  `Nu = {0.825 + 0.387·Ra^(1/6) / [1 + (0.492/Pr)^(9/16)]^(8/27)}²`, `L` = part height
- **Horizontal, hot side up** (or cold side down):
  `Nu = 0.54·Ra^(1/4)` for `Ra < 1e7`, `0.15·Ra^(1/3)` above; `L = A/P`
- **Horizontal, hot side down** (or cold side up): `Nu = 0.27·Ra^(1/4)`; `L = A/P`

`h = Nu·k_air/L`, clamped to `[1, 500]` W/m²K for numerical sanity.

The hot/cold classification uses `sign(T_s − T_amb)`, so **sub-ambient simulation needs
no special case** — a cold plate facing up is the cold-side-up branch, which is the same
correlation as hot-side-down. This is the entire "reverse dissipation" feature.

Cavity-facing triangles use the cavity's own condition rather than the correlation.

### Radiation

Linearised each Picard iteration:

```
h_rad = ε · σ · (T_s² + T_amb²) · (T_s + T_amb)
```

with `T` in kelvin. `ε` comes from the part's surface finish, not its material — bare
SS304 is ≈0.15, the same steel painted is ≈0.9, and on a 200 °C part that dominates the
total loss. Cavity-facing surfaces get a reduced effective emissivity (enclosure
approximation) rather than full view to ambient.

### Assembly

For each DOF *i*:

```
A[i][i] += Σ G_ij  +  (h_conv,i + h_rad,i) · A_i
A[i][j] -= G_ij
b[i]    += (h_conv,i + h_rad,i) · A_i · T_amb  +  Q_i
```

Contacts add `G_contact = h_c · A_contact` between the paired DOFs.

Fixed temperatures are applied by row elimination (zero the row, set diagonal to 1, set
`b` to the value, and symmetrically fold the known value into the other rows' RHS) so the
matrix stays symmetric positive-definite.

### Solve

Jacobi-preconditioned conjugate gradient on a CSR matrix. Picard outer loop:

1. Initialise `T` from ambient, or from the previous solution when a parameter changed
2. Recompute `h_conv` and `h_rad` from current `T`
3. Assemble and solve
4. Repeat until `max|ΔT| < 0.01 K` or 40 iterations

Warm-starting from the previous solution makes interactive parameter tweaks converge in
2–3 outer iterations instead of 10–15.

**Energy conservation is asserted on every solve:** total power injected at fixed-
temperature nodes plus heat loads must equal total power lost to ambient, within solver
tolerance. A violation is a bug, and it is reported rather than silently ignored.

---

## 6. Geometry pipeline

### Import

| Format | Loader | Parts | Faces |
|---|---|---|---|
| STEP | `occt-import-js` (OpenCascade WASM) | named solids from the assembly | `brep_faces` ranges |
| STL | custom parser (binary + ASCII) | connected components | dihedral-derived regions |
| OBJ | three.js `OBJLoader` | `o`/`g` groups | dihedral-derived regions |

Tessellation quality (`linearDeflection`, `angularDeflection`) is exposed as an import
setting — it controls mesh density and therefore solve cost.

**Node budget.** Above a configurable budget (default 150 k nodes) the import offers
decimation. Render mesh and solve mesh are the same mesh; keeping them identical avoids a
whole class of mapping bugs and lets colours be written per node directly.

**Verify early:** confirm `occt-import-js` exposes `brep_faces` ranges per mesh in its
result. If it does not, STEP falls back to dihedral-derived face regions like STL — the
selection UX is identical either way, so this is a contained risk.

### Face regions for STL/OBJ

Flood-fill triangles across shared edges whose dihedral angle is below a threshold
(default 20°). Produces planar and smoothly-curved regions that behave like B-rep faces
for selection. One code path serves all formats downstream.

### Feature edges

Mesh edges whose dihedral angle exceeds the threshold, chained into polylines. Used for
edge selection and for the wireframe-style overlay. Derived uniformly for all formats —
B-rep edge recovery from STEP is not worth a second code path.

### Cavity detection

For each triangle, cast a ray along its outward normal. Rays that hit another triangle of
the assembly an odd number of times, or never escape the bounding volume, mark the
triangle as inside-facing. Inside-facing triangles are grouped into connected cavities by
flood fill.

Each cavity gets a user-settable condition: `stillAir` (low h), `insulated`
(configurable, near-zero h), or `adiabatic` (h = 0). The cavity also carries a fill
material, which the 2D cut-plane solve uses.

Ray casting uses a BVH over the triangle set; a few thousand rays is milliseconds.

### Contact detection

Spatial hash over nodes. Node pairs on **different parts** closer than a tolerance
(default 0.2 mm, user-adjustable) become candidate links. Candidates are grouped into
contact patches by connectivity and presented as a list the user can inspect, delete, or
add to by picking two faces.

Each contact carries a conductance in W/m²K, defaulting to a `perfect` preset (1e6). This
is what lets a bolted joint, a welded seam, and two parts that merely touch behave
differently.

---

## 7. Analysis outputs

All four are wanted.

### 7.1 Cut plane — profile line and filled 2D field

A draggable, orientable section plane in the 3D view drives both.

**Profile line.** Intersect the plane with every triangle, producing segments with
temperatures interpolated from node values. Chain segments into polylines, parameterise
by arc length, plot temperature vs distance. Threshold marker lines are overlaid (the
"55 °C controller limit" in the reference).

**Filled 2D field.** On the same plane:

1. Rasterise the plane region over the model bbox into a grid (default 256²)
2. Classify cells using the section polylines and the cavity map: shell, cavity interior,
   or open air
3. Cells adjacent to a shell segment take that segment's interpolated temperature as a
   Dirichlet condition; open-air cells are pinned to ambient
4. Solve the 2D Laplacian over cavity cells with the cavity's fill conductivity
5. Render with the shared colormap, contours by marching squares

Approximate — it ignores out-of-plane flux — and labelled as such in the UI. Superseded
by the voxel backend when that lands.

### 7.2 Temperature vs conduction path length

Dijkstra over the conduction graph (shell edges plus contact links, weighted by Euclidean
distance) from the set of fixed-temperature source nodes. Every node is then plotted as
(path length, temperature).

Least-squares fit of `T = T_∞ + ΔT·exp(−s/λ)` gives the fin length λ, plotted over the
scatter. This is the plot that answers "how far does heat actually travel", and it is the
one a general FEA package will not give you.

### 7.3 Heat balance

Total watts to ambient, split per part and per mechanism (convection vs radiation), plus
watts crossing each contact and injected at each fixed-temperature boundary. This is both
a user-facing result and the primary sanity check that a solve is physical.

### 7.4 Area above threshold

Histogram of surface area by temperature, plus "X cm² exceeds T" for a user-set limit,
broken down by contributing part.

---

## 8. Viewer and interaction

Built on the existing prototype's approach — three.js, per-vertex colours, orbit camera,
hover readout — extended with:

- **Selection modes**: part / face / edge / point, hotkeys `1`–`4`. Hover highlights the
  entity under the cursor at the active granularity; click selects; shift-click adds.
- **Colour scale**: explicit min/max entry, plus `auto` (solution range) and
  `ambient→max` presets. Colormaps: inferno, viridis, turbo, and a diverging map centred
  on ambient — the diverging map is what makes a mixed hot-and-cold model readable.
- **Part visibility**: per-part show/hide/isolate and transparency, so interior parts can
  be inspected.
- **Section gizmo**: plane with position and orientation handles, snapping to principal
  axes; the plane also clips the 3D view so the section is visible in context.
- **Overlays**: contact patches, fixed-temperature boundaries, heat loads, and cavity
  faces each toggleable, drawn as coloured highlights on the mesh.

Panels: part tree, material/finish editor, boundary conditions, contacts, cavities,
ambient and solve settings, plots.

---

## 9. Persistence

Project files are JSON (`.hds.json`): all of `Scenario`, plus camera, plot settings, and
a reference to the source CAD file by name and hash. Optionally embeds the tessellated
mesh so a project opens standalone.

Scenario entities reference geometry by stable IDs (part name + ordinal, face index). On
re-import of a modified CAD file, IDs are re-matched by name and any that fail to resolve
are reported rather than silently dropped.

---

## 10. Testing

### Unit
- Convection correlations against textbook values at known Ra and Pr
- Cotangent weights on hand-computed triangles, including an obtuse one
- Vertex welding on a mesh with known duplicates
- Dijkstra on a small hand-built graph
- CSR assembly and CG on small systems with known solutions

### Analytical benchmarks — the ones that matter

1. **1D fin.** A long strip, one end fixed at `T_h`, convection on both faces. Analytic:
   `T(x) = T_∞ + ΔT·cosh(m(L−x))/cosh(mL)`, `m = √(2h/kt)`. Validates conduction and
   convection coupling *and* the path-length/λ plot in one test.
2. **Isothermal plate.** Uniform plate at fixed T; total loss must equal
   `hA·ΔT + εσA(T⁴−T_∞⁴)`. Validates the heat balance report.
3. **Two-part contact.** Two strips joined through a known contact conductance, one end
   fixed. Analytic series resistance. Validates contacts.
4. **Energy conservation.** Asserted on every solve, in every test, as an invariant.
5. **Sub-ambient symmetry.** A model at `T_∞ − 50` must produce a field that mirrors the
   `T_∞ + 50` case under the convection correlation's own asymmetry — verifies the sign
   handling has no hidden hot-only assumption.

### Integration

Load `ohisje - TBTE 2x116.step`, apply the reference scenario (1 mm SS304, rim at 200 °C,
20 °C still air, insulated cavity) and check the result against the known-good values from
`thermal_field.png`: **≈61 W total loss to ambient** and **fin length λ ≈ 46 mm**. This is
a real regression test against an already-trusted result and should be wired up as soon
as the solver runs end to end.

---

## 11. Delivery phases

| Phase | Contents | Done when |
|---|---|---|
| M1 | Scaffold, core types, STEP/STL/OBJ import, ThermalModel build, part tree, viewer with selection | The TBTE assembly loads, parts are individually selectable and hideable |
| M2 | Materials, finishes, shell solver, fixed-temp BC, ambient, colour scale, heat balance | A field is computed and shaded; benchmarks 1, 2 and 4 pass |
| M3 | Contacts, cavities, face/edge/point BCs, heat loads | Benchmark 3 passes; the TBTE integration test hits ≈61 W |
| M4 | All four analysis outputs | The four reference plots are reproducible |
| M5 | Project save/load, import settings, decimation, polish | A session survives reload |
| M6 (later) | Voxel volumetric backend behind the solver interface | True volumetric cross-sections |

---

## 12. Known limitations

Stated plainly, because they set expectations for what the results mean:

- No airflow. Convection is a correlation, not a fluid solve. Forced convection is a
  user-supplied `h`, not a computed one.
- No radiative view factors between surfaces. Radiation is surface-to-ambient, with an
  enclosure approximation inside cavities.
- Shell conduction assumes through-thickness temperature is uniform — true for sheet
  metal, less so for thick parts, which is why `lump` exists.
- The 2D cut-plane fill ignores out-of-plane conduction.
- Steady-state only; no thermal mass, no warm-up curves.
