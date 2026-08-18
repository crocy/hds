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

pnpm's version is pinned in `packageManager`. Running it needs corepack 0.34.7
specifically — newer corepack requires a Node that Ubuntu does not ship yet — see
`.claude/session-handoff.md` if `pnpm` will not start.

## Deployment

Live at **https://crocy.github.io/hds/**, rebuilt by GitHub Actions on every push to
`main`. The workflow runs typecheck, lint and the full suite before it builds, so a
broken commit cannot reach the public URL.

The site is served from the `/hds/` subpath, which `vite.config.ts` sets as `base`.
Anything that loads a file out of `public/` must resolve it through
`import.meta.env.BASE_URL`, never a leading `/` — an absolute path silently returns
`index.html` instead of the asset. `base` is a constant rather than build-only, so
`pnpm dev` serves the same subpath and a mistake shows up locally rather than in
production.

## Appearance

The Display panel carries a system / dark / light choice, remembered per machine
and never written into a project file — opening a colleague's `.hds.json` leaves your
theme alone.

Light theme's viewport is mid-grey rather than white, which is the one part of it worth
knowing about. Every thermal colormap runs from near-black to near-white, so whichever
pole the background sits at swallows the matching end of the ramp: on white the hot end
disappears, and the hot end is what you opened the app to find. Mid-grey is where
neither end is lost, and it leaves the colormap itself untouched so a screenshot from
one theme still colour-matches the other. See
[the theme spec](docs/superpowers/specs/2026-08-16-ui-theme-design.md) for the
measurements.

## What it models

Steady-state conduction across the tessellated surface — each triangle carries
`k × thickness` — with natural convection and radiation to ambient at every node.
Parts are joined by explicit contacts carrying a finite conductance.

Enclosed cavities are detected by occlusion, and walls that can see each other across
the void are joined into one pocket — parts separated by a gap share no mesh edge, and a
pocket walled by a single part equilibrates with it and carries nothing. Each pocket
holds its own trapped-air temperature, solved as a real unknown alongside the nodes. A sealed pocket is therefore a
thermal path between the walls that bound it rather than somewhere heat can vanish into:
what flows in flows back out, and the cavities panel reports each pocket's air
temperature and shows that its books balanced.

A part can also be marked `solid`, which fills it with cells and conducts it in three
dimensions. That is what a thick low-conductivity body needs: as a sheet it conducts
along its own skin, so 40 mm of glass wool short-circuits the very thickness it exists
to resist with. The part's thickness sets the cell size rather than its conduction, and
the through-thickness resistance is `t/(k·A)` exactly, at any cell count.

Sub-ambient simulation works without a separate mode: the convection correlations branch
on the *sign* of ΔT, so a cold plate facing up takes the same branch as a hot plate
facing down.

Read [the design spec](docs/superpowers/specs/2026-08-14-thermal-simulator-design.md)
for the full model, and section 12 of it for the limitations — no airflow solve, no
radiative view factors between surfaces, no thermal mass.

## Layout

| Path | Contents |
|---|---|
| `src/core/` | Shared type contract, units, defaults, target helpers, test fixtures |
| `src/geometry/` | Importers, mesh build and welding, topology, cavities, contacts, sectioning |
| `src/physics/` | Materials, convection, radiation, sparse assembly, solver |
| `src/analysis/` | Path length, heat balance, 2D slice, thresholds |
| `src/viewer/` | three.js scene, picking, colormaps, section gizmo |
| `src/ui/` | React panels, state, plots and the theme |

`src/physics/` and `src/analysis/` import neither three.js nor React. They take typed
arrays in and return typed arrays out, which is what keeps the solver testable in Node
and lets a volumetric backend replace the shell solver behind the `ThermalSolver`
interface.

## Verification

The solver is checked against analytical results — a 1D fin, an isothermal plate, and a
two-part contact with known series resistance — and energy conservation is asserted on
every solve. A slab filled with cells is checked against `t/(k·A)` at three grid
resolutions, which is what says the volumetric mode means anything. Each sealed cavity's
net flow is asserted to be zero too, which is what stops a trapped pocket quietly
becoming a heat sink — though note that until walls were joined by sight line, every
pocket was walled by a single part and that assertion passed for free.

There is also an end-to-end test against the TBTE housing in this repo. Read its header
before trusting any single number from it: the known-good prior run is a **mid-surface**
model carrying one side of each sheet, so its 61 W is the loss from the skin facing
ambient and is *not* comparable to our total. We solve the sheet solid the CAD actually
contains, and report 93.3 W — all of it through that same skin, since a sealed pocket has
no other exit. The gap is a heat path the reference mesh has no interior to carry: the
buried block radiating across the pocket, whose walls the block and the skin both belong
to. It read 82.5 W while cavities were grouped by shared mesh edge alone, which put the
block in a pocket of its own and left that path claimed but absent.

Two caveats worth knowing before reading the plots:

- The fin length the test prints (94.3 mm) is **not asserted**. It does not match the
  ≈46 mm this file claimed for a long time, but that figure was never comparable: fitting
  the same decay over the reference's *own* field gives 104 mm across the whole model and
  34–45 mm restricted to the first 50–100 mm. So ≈46 mm is a near-field fit and ours is a
  whole-model one — section 10 of the design spec has the numbers. What is genuinely open
  is the drift within our own numbers: 93.0 mm before cavities gained an air node, 97.4 mm
  after, and 94.3 mm once those pockets were joined by sight line.
- The reference run no longer bounds the total from above. Per-cavity conservation is
  what holds the model honest in its place — a check of internal consistency, which is a
  weaker thing than agreement with reality.

See [the cavity air node spec](docs/superpowers/specs/2026-08-15-cavity-air-node-design.md)
for the full reasoning, including the one known approximation.
