/**
 * Radiation, linearised into a film coefficient so it can join the same linear system
 * as conduction and convection.
 *
 * h_rad = ε·σ·(Ts² + T∞²)·(Ts + T∞) is exact rather than approximate: multiplied by
 * (Ts − T∞) it factors straight back into εσ(Ts⁴ − T∞⁴).
 *
 * That identity only holds when the temperature the coefficient is built from is the
 * same one the (Ts − T∞) factor is later applied at, which is why the coefficient is
 * evaluated per **node**. The heat balance integrates σ(T⁴ − T∞⁴) node by node;
 * linearising anywhere else — at each triangle's mean corner temperature, say — leaves
 * the two accounts of the same watt disagreeing wherever the surface has a gradient,
 * and always in the same direction, because T⁴ is convex.
 *
 * The only approximation left is that h_rad lags one Picard iteration behind the field.
 */

import type { Cavity, Scenario, ThermalModel } from '../core/types';
import { resolvePart } from './materials';

/** W/(m²·K⁴) */
export const STEFAN_BOLTZMANN = 5.670374419e-8;

export function radiationCoefficient(
  emissivity: number,
  tSurface: number,
  tAmbient: number,
): number {
  if (emissivity <= 0) return 0;
  const ts = Math.max(tSurface, 0);
  const ta = Math.max(tAmbient, 0);
  return emissivity * STEFAN_BOLTZMANN * (ts * ts + ta * ta) * (ts + ta);
}

/**
 * Effective emissivity per triangle, 0..1.
 *
 * Emissivity comes from the part's surface finish, never its material. Cavity-facing
 * triangles use the cavity's reduced enclosure emissivity instead of full view to
 * ambient; an adiabatic cavity and an insulator part radiate nothing at all.
 */
export function computeTriangleEmissivity(
  model: ThermalModel,
  scenario: Scenario,
  out?: Float32Array,
): Float32Array {
  const emissivity = out && out.length === model.triCount ? out : new Float32Array(model.triCount);
  const cavities = new Map<number, Cavity>(scenario.cavities.map((cavity) => [cavity.id, cavity]));

  const partEmissivity: number[] = [];
  const partInsulated: boolean[] = [];
  for (const part of model.parts) {
    const resolved = resolvePart(part, scenario.partOverrides[part.id]);
    partEmissivity.push(resolved.finish.emissivity);
    partInsulated.push(resolved.bodyType === 'insulator');
  }

  for (let t = 0; t < model.triCount; t++) {
    const part = model.triPart[t];
    if (partInsulated[part]) {
      emissivity[t] = 0;
      continue;
    }

    let value = partEmissivity[part];
    const cavityId = model.triCavity[t];
    if (cavityId !== 0) {
      const cavity = cavities.get(cavityId);
      if (cavity) value = cavity.condition === 'adiabatic' ? 0 : cavity.emissivity;
    }
    emissivity[t] = value;
  }

  return emissivity;
}

/**
 * Effective emissivity per node, 0..1 — the area-weighted mean over its triangles.
 *
 * Emissivity and the cavity-versus-ambient condition are per triangle, but the
 * linearised coefficient has to be per node, so a node on the rim of a cavity opening
 * needs one number covering both sides of it. Each triangle is weighted by the A_t/3 it
 * hands that corner, which is the same share the assembly spreads its surface terms
 * over: ε_node·nodeArea therefore reproduces Σ ε_t·A_t/3 exactly. What moves is where
 * the coefficient is evaluated, not how much area radiates at what emissivity.
 */
export function computeNodeEmissivity(
  model: ThermalModel,
  scenario: Scenario,
  out?: Float64Array,
): Float64Array {
  const emissivity =
    out && out.length === model.nodeCount ? out : new Float64Array(model.nodeCount);
  emissivity.fill(0);
  const triEmissivity = computeTriangleEmissivity(model, scenario);

  for (let t = 0; t < model.triCount; t++) {
    const share = (triEmissivity[t] * model.triArea[t]) / 3;
    if (share === 0) continue;
    emissivity[model.tris[t * 3]] += share;
    emissivity[model.tris[t * 3 + 1]] += share;
    emissivity[model.tris[t * 3 + 2]] += share;
  }

  for (let node = 0; node < model.nodeCount; node++) {
    const area = model.nodeArea[node];
    emissivity[node] = area > 0 ? emissivity[node] / area : 0;
  }
  return emissivity;
}

/** Per-node linearised radiation coefficient, W/(m²·K), at that node's own temperature. */
export function computeNodeRadiationCoefficients(
  model: ThermalModel,
  emissivity: ArrayLike<number>,
  temperature: ArrayLike<number>,
  ambient: number,
  out?: Float64Array,
): Float64Array {
  const h = out && out.length === model.nodeCount ? out : new Float64Array(model.nodeCount);
  for (let node = 0; node < model.nodeCount; node++) {
    h[node] = radiationCoefficient(emissivity[node], temperature[node], ambient);
  }
  return h;
}
