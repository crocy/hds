# Cavity air node — sealed pockets stop being heat sinks

**Status:** approved design, 2026-08-15
**Scope:** `src/physics/assemble.ts`, `src/physics/radiation.ts`, `src/analysis/balance.ts`, `src/core/types.ts`
**Amends:** [2026-08-14 thermal simulator design](2026-08-14-thermal-simulator-design.md) §5 Radiation, §5 Assembly, §7.3 Heat balance, §12 Known limitations

---

## 1. Problem

Cavity detection works. Occlusion classification finds 59.5 % of the TBTE assembly's
7734 cm² as inside-facing, which is what a sealed sheet housing should give.

What the solver then does with those surfaces is wrong. A cavity-facing triangle gets a
reduced film coefficient and a reduced enclosure emissivity, and then exchanges heat with
`scenario.ambient` — a fixed, infinite 20 °C sink. Heat crossing an inner wall is counted
as having reached the room without passing through the outer wall.

A sealed pocket is not a sink. It is a thermal resistance between the walls that bound
it. Heat entering it must leave through those walls or not at all.

Measured on TBTE, the size of the error:

| Cavity condition              | Total loss | Note                                                   |
| ----------------------------- | ---------- | ------------------------------------------------------ |
| `insulated` (current default) | 101.52 W   | 62.49 W convection + 39.02 W radiation                 |
| `adiabatic`                   | 78.89 W    | the ~23 W difference is heat sinking into a sealed box |

The like-for-like comparison against the reference run is already good — the reference is
a **mid-surface** model with no interior faces, so its 61 W is outer-skin loss, and ours
is 64.77 W over 3136 cm² against its 3194 cm². The defect is not that the physics is
badly calibrated. It is that the model reports a total which includes watts that go
nowhere real.

## 2. Decisions

| Decision                        | Choice                                                                           | Rationale                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Cavity temperature              | One unknown per cavity, in the same linear system                                | Steady state with no capacity means its row _is_ the conservation statement                                                          |
| Coupling                        | Symmetric `h·A` between wall DOF and cavity DOF                                  | Keeps the matrix SPD, so the existing Jacobi-preconditioned CG is unchanged                                                          |
| Leakage to ambient              | None — cavities are perfectly sealed                                             | One clear invariant to test. Slightly pessimistic on a vented box, which is the safe direction                                       |
| Radiation inside a cavity       | Wall-to-cavity at the enclosure emissivity, linearised at the cavity temperature | Keeps the existing enclosure approximation; no view factors                                                                          |
| Rim nodes touching two cavities | Assigned wholly to the cavity holding the larger area at that node               | Heat still lands in _a_ sealed pocket, so the invariant holds; only which pocket is approximate                                      |
| Adiabatic cavities              | No DOF allocated                                                                 | `h = 0`, `ε = 0` leaves a singular row; skipping it beats leaning on the isolated-DOF rescue, whose warning would be misleading here |
| Detection                       | Unchanged                                                                        | `cavity.ts` already does its job                                                                                                     |

## 3. Data model

`buildDofMap` currently returns one DOF per solved node. It gains one DOF per
non-adiabatic cavity, appended after the node DOFs:

```ts
export interface DofMap {
  nodeDof: Int32Array;
  dofPart: Int32Array;
  /** DOF of each cavity's trapped air, indexed by cavity id. -1 for adiabatic or absent. */
  cavityDof: Int32Array;
  /** Node DOFs occupy 0..nodeDofCount; cavity DOFs follow. */
  nodeDofCount: number;
  dofCount: number;
}
```

Splitting `nodeDofCount` from `dofCount` matters downstream: everything that walks the
solution vector to write node temperatures must stop at `nodeDofCount`, and the cavity
tail is read separately. `dofPart` stays node-only and is indexed within `nodeDofCount`.

Throughout this document a **live cavity** is a detected cavity that owns a DOF — that
is, one whose condition is not `adiabatic`. Triangles belonging to any other cavity, and
open-air triangles, keep their current treatment.

`HeatBalance` gains a per-cavity report, so the invariant is visible in the UI rather
than only in tests:

```ts
perCavity: Array<{
  cavityId: number;
  /** kelvin */
  temperature: number;
  /** Net watts into the cavity. Must be ~0. */
  netFlow: number;
}>;
```

## 4. Assembly

### Convection

Today, for every triangle corner, [assemble.ts](../../../src/physics/assemble.ts):

```ts
builder.add(dof, dof, hArea);
rhs[dof] += hArea * scenario.ambient;
```

For a triangle whose `triCavity` is a live cavity, the ambient source term is replaced by
a symmetric coupling to that cavity's DOF:

```ts
builder.add(dof, dof, hArea);
builder.add(cav, cav, hArea);
builder.add(dof, cav, -hArea);
builder.add(cav, dof, -hArea);
```

Open-air triangles are untouched.

The cavity row accumulates only these couplings and never receives a source term. At
convergence it therefore states exactly `Σ h·A·(T_wall − T_cavity) = 0` — energy
conservation for the pocket is imposed by the matrix, not asserted afterwards.

### Radiation, and the per-node split

This is the fiddly part, and the reason the change is not purely mechanical.

Radiation is applied per **node**, not per triangle, because `h_rad` reproduces
`εσ(T⁴ − T∞⁴)` exactly only when it is linearised at the same temperature the difference
is taken at. A node on a cavity rim has incident triangles in both environments, and
`computeNodeEmissivity` currently area-weights them into one number aimed at ambient.

The same carry-over happens a second time, for convection: `nodeConvectionCoefficients`
in [solve.ts](../../../src/physics/solve.ts) area-weights `hConv[t]` onto nodes so the
heat balance can work per node. Both need the identical treatment, so this is one shared
helper rather than two parallel implementations:

```ts
/** Carries a per-triangle surface coefficient onto nodes, split by what it exchanges with. */
export interface NodeSurfaceSplit {
  toAmbient: Float64Array;
  toCavity: Float64Array;
  /** Which cavity `toCavity` belongs to, per node. -1 where there is none. */
  nodeCavity: Int32Array;
}

export function splitNodeCoefficient(
  model: ThermalModel,
  perTriangle: ArrayLike<number>,
  cavityDof: Int32Array,
): NodeSurfaceSplit;
```

Each share is normalised by `nodeArea[node]`, preserving the existing property that
`coefficient_node · nodeArea` reproduces `Σ c_t·A_t/3` exactly. The two shares sum to
today's single blended value, so no radiating or convecting area is created or lost.

Where a node's cavity-facing triangles belong to more than one cavity, the whole share
goes to the cavity with the largest area at that node. This is a bounded approximation,
not a leak: the heat still enters a sealed pocket and still cannot escape the assembly.

The ambient share assembles as it does now. The cavity share assembles symmetrically
against `cavityDof[nodeCavity[node]]`, linearised at that cavity's temperature from the
previous Picard iteration. The outer loop already refreezes coefficients each pass, so
this converges by the same argument as the wall temperatures.

Assembly of convection stays per triangle, where it already is and where `triCavity` is
directly available — the split exists for the balance, and for the per-node radiation the
solver has always assembled that way.

### Adiabatic cavities

`cavityDof` is `-1` for them. Their triangles have `h = 0` and `ε = 0` and so contribute
nothing, exactly as today. No DOF is allocated, no row is singular, and no spurious
"exchanges no heat with anything" warning is raised.

## 5. Heat balance

`computeHeatBalance` in [balance.ts](../../../src/analysis/balance.ts) takes
`hConvection[node]` and `emissivity[node]` and evaluates both against
`scenario.ambient`. Its doc comment already states the contract — "cavity de-rating is
the caller's job" — and that stays true: the caller now hands it the `toAmbient` share of
each split, so the module still knows nothing about enclosures.

Cavity exchange is therefore absent from `lostByConvection` and `lostByRadiation` by
construction rather than by a skip test. It is reported per cavity instead, where
`netFlow` is computed from the `toCavity` shares — independently of the matrix, so it is
a genuine check rather than an algebraic identity.

`HeatBalanceInput` gains the `toCavity` shares and the cavity temperatures it needs to
compute `perCavity`. `residual = injected − lost` keeps its meaning and its alarm, which
`main` has since tightened to 0.1 % of throughput (`ENERGY_RESIDUAL_FRACTION = 1e-3`).

The `toCavity` shares are needed for a second reason, found in implementation and not
anticipated above: a **pinned** wall shedding into a pocket is injecting power into the
model, and `injectedAtFixed` has to count it or the residual cannot close.

## 6. Invariants

1. **A sealed cavity conserves energy.** For every live cavity, the net flow across its
   walls is zero within solver tolerance. Imposed by the matrix row; verified independently
   in the balance.

   One caveat, found in implementation. Convection assembles per triangle while `netFlow`
   sums per node, so for a node whose cavity-facing triangles span two live cavities the
   two attribute that node's heat to different pockets. The sum over all cavities still
   cancels, so no energy is created or lost; only the per-pocket split is approximate. The
   TBTE assembly contains no such node. If one ever matters, the fix is to assemble
   convection through the same per-node split radiation already uses.

2. **Ambient is the only exit.** Total loss equals the loss through open-air triangles.
   After this change those are the same surfaces, so the two figures must agree.
3. **No exchanging area is created or destroyed.** For every node and for both
   coefficients, `toAmbient + toCavity` equals the single blended value the current code
   computes.
4. **A cavity sits between its walls' extremes.** Its temperature is bounded by the
   minimum and maximum wall temperature bounding it — a weighted mean cannot exceed its
   inputs.

## 7. Testing

### Unit

- A two-shell box fixture — inner shell hot, outer shell to ambient — small enough to
  reason about by hand. Asserts invariants 1 and 4, and that total loss is unchanged by
  refining the cavity's mesh.
- `splitNodeCoefficient`: invariant 3, on a fixture with a rim node straddling cavity and
  open air. Run for both emissivity and convection, since one helper now serves both.
- A rim node bridging two cavities lands wholly in the larger one, and nothing is lost.
- An adiabatic cavity allocates no DOF and raises no warning.

### Integration — TBTE

The falsifiable prediction. Before the change, total loss was 101.52 W while loss through
the open-air skin was 64.77 W. After it the outer skin is the only way out, so:

- total loss must equal open-air loss to within the balance residual
- total loss must fall well below the 101.52 W the sink produced
- the open-air area assertion (3136 cm² against the reference mesh's 3194 cm²) is
  unaffected, because detection does not change

If total and open-air loss do not converge, the change is wrong. That assertion is the
point of the test.

**Measured: 82.49 W, total and open-air identical**, worst per-cavity net flow 4.7e-5 W,
residual 2.2e-6 of the loss, and the seven "exchange no heat with anything" warnings gone.

That is above the 78.89 W an adiabatic run gives, which was the figure this section first
predicted. Adiabatic was the wrong anchor: it seals the pocket off entirely, whereas a
cavity air node lets the pocket _transport_ the buried block's heat to the skin. More heat
reaching the skin than in the adiabatic case is the expected direction, not an overshoot.

It also widens the gap to the reference run's 61 W, measured over the same surface, and
that deserves stating plainly rather than burying. The skin's conductance still agrees:
2.46 W/K here against the reference's 2.66 W/K. What differs is that our structure runs
33.5 K above ambient where the reference runs 22.9 K, because we now carry heat across the
pocket by convection and radiation and a mesh with no interior faces cannot. The reference
therefore no longer bounds the total from above, and the integration test says so in place
of its old `< 72 W`. Losing that bound is a real cost of this change; the per-cavity
conservation check is what replaces it as the thing holding the model honest.

Because that cross-pocket path is mostly radiation, the whole result rests on the
enclosure emissivity driving it. `CAVITY_DEFAULTS.insulated.emissivity = 0.2` was
therefore checked against the hardware rather than assumed: the block is bare aluminium,
and 0.2 is the oxidised-bare figure, consistent with the SS304 inner skin's 0.15. It
stays. Anyone tempted to lower it to close the gap to 61 W should note that this is the
wrong direction of reasoning — the gap is a consequence of the physics, not evidence
against the coefficient.

### Unchanged

All 10 tests in [cavity.test.ts](../../../src/geometry/cavity.test.ts) must keep passing
untouched — detection is not in scope.

## 8. Out of scope

- Cavity detection (`cavity.ts`)
- The `stillAir` / `insulated` / `adiabatic` presets, which go on setting the wall film
  coefficient and enclosure emissivity
- `fillK` and the 2D cut-plane solve
- Radiative view factors between individual surfaces — still the enclosure approximation
- Buoyant circulation inside a cavity; `h` remains a user-set film coefficient

## 9. Amendments to the parent spec

§12 Known limitations loses "radiation is surface-to-ambient" as a blanket statement and
gains:

- A cavity is one well-mixed air temperature, not a fluid solve. Stratification inside a
  tall pocket is not modelled, and `h` is a film coefficient the user sets rather than one
  derived from the pocket's geometry.
- Cavities are treated as perfectly sealed. A genuinely vented or louvred enclosure will
  read hotter than reality, which is the conservative direction.
