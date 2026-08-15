/**
 * Radiation, linearised into a film coefficient so it can join the same linear system
 * as conduction and convection.
 *
 * h_rad = ε·σ·(Ts² + T∞²)·(Ts + T∞) is exact rather than approximate: multiplied by
 * (Ts − T∞) it factors straight back into εσ(Ts⁴ − T∞⁴). The only approximation is
 * that h_rad lags one Picard iteration behind the temperature it is evaluated at.
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
 * Per-triangle linearised radiation coefficient, W/(m²·K).
 *
 * Emissivity comes from the part's surface finish, never its material. Cavity-facing
 * triangles use the cavity's reduced enclosure emissivity instead of full view to
 * ambient.
 */
export function computeRadiationCoefficients(
  model: ThermalModel,
  scenario: Scenario,
  temperature: Float32Array,
  out?: Float32Array,
): Float32Array {
  const h = out && out.length === model.triCount ? out : new Float32Array(model.triCount);
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
      h[t] = 0;
      continue;
    }

    let emissivity = partEmissivity[part];
    const cavityId = model.triCavity[t];
    if (cavityId !== 0) {
      const cavity = cavities.get(cavityId);
      if (cavity) emissivity = cavity.condition === 'adiabatic' ? 0 : cavity.emissivity;
    }

    const tSurface =
      (temperature[model.tris[t * 3]] +
        temperature[model.tris[t * 3 + 1]] +
        temperature[model.tris[t * 3 + 2]]) /
      3;
    h[t] = radiationCoefficient(emissivity, tSurface, scenario.ambient);
  }

  return h;
}
