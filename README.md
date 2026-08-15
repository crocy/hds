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
Parts are joined by explicit contacts carrying a finite conductance. Enclosed cavities
are detected and given their own convection condition.

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
every solve. There is also a regression test against a known-good prior result for the
TBTE housing in this repo: ≈61 W total loss and a ≈46 mm fin length.
