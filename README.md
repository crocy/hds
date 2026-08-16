# HDS — heat dissipation simulator

Browser-based steady-state thermal simulator for CAD assemblies. Load a STEP, STL or
OBJ model, assign materials and boundary conditions to its parts, solve the temperature
field, and read the result as a shaded 3D model plus cross-section and path-length plots.

Everything runs client-side. CAD files are never uploaded.

## Running

```bash
pnpm install
pnpm dev
```

Other commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.

## What it models

Steady-state conduction across the tessellated surface — each triangle carries
`k × thickness` — with natural convection and radiation to ambient at every node.
Parts are joined by explicit contacts carrying a finite conductance.

Enclosed cavities are detected by occlusion and each holds its own trapped-air
temperature, solved as a real unknown alongside the nodes. A sealed pocket is therefore a
thermal path between the walls that bound it rather than somewhere heat can vanish into:
what flows in flows back out, and the cavities panel reports each pocket's air
temperature and shows that its books balanced.

Sub-ambient simulation works without a separate mode: the convection correlations branch
on the *sign* of ΔT, so a cold plate facing up takes the same branch as a hot plate
facing down.

Read [the design spec](docs/superpowers/specs/2026-08-14-thermal-simulator-design.md)
for the full model, and section 12 of it for the limitations — no airflow solve, no
radiative view factors between surfaces, no thermal mass.

## Layout

| Path | Contents |
|---|---|
| `src/core/` | Shared type contract, units, defaults, test fixtures |
| `src/geometry/` | Importers, mesh build and welding, topology, cavities, contacts, sectioning |
| `src/physics/` | Materials, convection, radiation, sparse assembly, solver |
| `src/analysis/` | Path length, heat balance, 2D slice, thresholds |
| `src/viewer/` | three.js scene, picking, colormaps, section gizmo |
| `src/ui/` | React panels and state |

`src/physics/` and `src/analysis/` import neither three.js nor React. They take typed
arrays in and return typed arrays out, which is what keeps the solver testable in Node
and lets a volumetric backend replace the shell solver behind the `ThermalSolver`
interface.

## Verification

The solver is checked against analytical results — a 1D fin, an isothermal plate, and a
two-part contact with known series resistance — and energy conservation is asserted on
every solve. Each sealed cavity's net flow is asserted to be zero too, which is what
stops a trapped pocket quietly becoming a heat sink.

There is also an end-to-end test against the TBTE housing in this repo. Read its header
before trusting any single number from it: the known-good prior run is a **mid-surface**
model carrying one side of each sheet, so its 61 W is the loss from the skin facing
ambient and is *not* comparable to our total. We solve the sheet solid the CAD actually
contains, and report 82.5 W — all of it through that same skin, since a sealed pocket has
no other exit. The gap is a heat path the reference mesh has no interior to carry: the
buried block radiating across the pocket.

Two caveats worth knowing before reading the plots:

- The fin length the test prints (97.4 mm) is **not asserted**. It does not match the
  ≈46 mm this file claimed for a long time, but that figure was never comparable: fitting
  the same decay over the reference's *own* field gives 104 mm across the whole model and
  34–45 mm restricted to the first 50–100 mm. So ≈46 mm is a near-field fit and ours is a
  whole-model one — section 10 of the design spec has the numbers. What is genuinely open
  is the drift within our own numbers, 93.0 mm before cavities gained an air node against
  97.4 mm after.
- The reference run no longer bounds the total from above. Per-cavity conservation is
  what holds the model honest in its place — a check of internal consistency, which is a
  weaker thing than agreement with reality.

See [the cavity air node spec](docs/superpowers/specs/2026-08-15-cavity-air-node-design.md)
for the full reasoning, including the one known approximation.
