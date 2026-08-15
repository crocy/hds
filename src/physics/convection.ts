/**
 * Natural-convection correlations, evaluated per triangle.
 *
 * The branch is chosen from the surface orientation relative to gravity AND the sign
 * of (T_surface − T_ambient). A cold plate facing up behaves like a hot plate facing
 * down: the fluid next to it is denser than the bulk and stays put. That single sign
 * rule is the whole sub-ambient / "reverse dissipation" feature — there is no
 * hot-only branch anywhere in this file.
 */

import type { Cavity, Part, Scenario, ThermalModel, Vec3 } from '../core/types';
import { resolvePart } from './materials';

/** Standard gravity, m/s². */
export const GRAVITY = 9.80665;

/** |n·ĝ| below this counts as a vertical wall. */
export const VERTICAL_COS_LIMIT = 0.34;

/** Correlation output is clamped to this range for numerical sanity. */
export const H_MIN = 1;
export const H_MAX = 500;

/** Characteristic lengths below this are meaningless and would blow up Nu·k/L. */
const MIN_LENGTH = 1e-4;

/** Rayleigh number at which the unstable horizontal correlation switches exponent. */
const RA_TURBULENT = 1e7;

export interface AirProperties {
  /** W/(m·K) */
  k: number;
  /** Kinematic viscosity, m²/s */
  nu: number;
  prandtl: number;
  /** Volumetric expansion coefficient, 1/K. */
  beta: number;
}

// Dry air at 1 atm, Incropera Table A.4. Interpolated rather than frozen at one
// temperature because film temperature swings from sub-ambient to several hundred °C.
const AIR_T = Float64Array.from([200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800]);
const AIR_K = Float64Array.from([
  0.01824, 0.02227, 0.02624, 0.03003, 0.03365, 0.03707, 0.04038, 0.0436, 0.04659, 0.04953, 0.0523,
  0.05509, 0.05779,
]);
const AIR_NU = Float64Array.from([
  7.59e-6, 11.44e-6, 15.89e-6, 20.92e-6, 26.41e-6, 32.39e-6, 38.79e-6, 45.57e-6, 52.69e-6, 60.21e-6,
  68.1e-6, 76.37e-6, 84.93e-6,
]);
const AIR_PR = Float64Array.from([
  0.737, 0.72, 0.707, 0.7, 0.69, 0.686, 0.684, 0.683, 0.685, 0.69, 0.695, 0.702, 0.709,
]);

export function airPropertiesAt(filmTemperature: number): AirProperties {
  const last = AIR_T.length - 1;
  const t = Math.min(Math.max(filmTemperature, AIR_T[0]), AIR_T[last]);
  let i = 0;
  while (i < last - 1 && AIR_T[i + 1] < t) i++;
  const span = AIR_T[i + 1] - AIR_T[i];
  const f = span > 0 ? (t - AIR_T[i]) / span : 0;
  return {
    k: AIR_K[i] + f * (AIR_K[i + 1] - AIR_K[i]),
    nu: AIR_NU[i] + f * (AIR_NU[i + 1] - AIR_NU[i]),
    prandtl: AIR_PR[i] + f * (AIR_PR[i + 1] - AIR_PR[i]),
    // Ideal gas: β = 1/T_film.
    beta: 1 / Math.max(filmTemperature, 1),
  };
}

/** Ra = g·β·ΔT·L³·Pr/ν². ΔT is taken as a magnitude; the sign drives the branch, not Ra. */
export function rayleighNumber(deltaT: number, length: number, air: AirProperties): number {
  const l = Math.max(length, MIN_LENGTH);
  return (GRAVITY * air.beta * Math.abs(deltaT) * l * l * l * air.prandtl) / (air.nu * air.nu);
}

/**
 * `horizontalUnstable` — buoyancy drives fluid away from the surface (hot facing up,
 * or cold facing down). `horizontalStable` — buoyancy pins it against the surface
 * (hot facing down, or cold facing up), which convects roughly half as well.
 */
export type ConvectionRegime = 'vertical' | 'horizontalUnstable' | 'horizontalStable';

export function classifyConvection(
  normalDotGravity: number,
  tSurface: number,
  tAmbient: number,
): ConvectionRegime {
  if (Math.abs(normalDotGravity) < VERTICAL_COS_LIMIT) return 'vertical';
  const facesUp = normalDotGravity < 0;
  const hotter = tSurface >= tAmbient;
  return hotter === facesUp ? 'horizontalUnstable' : 'horizontalStable';
}

export function nusseltNumber(regime: ConvectionRegime, rayleigh: number, prandtl: number): number {
  const ra = Math.max(rayleigh, 0);
  switch (regime) {
    case 'vertical': {
      // Churchill–Chu, valid across the whole Ra range for a vertical plate.
      const pr = Math.max(prandtl, 1e-6);
      const denominator = Math.pow(1 + Math.pow(0.492 / pr, 9 / 16), 8 / 27);
      const root = 0.825 + (0.387 * Math.pow(ra, 1 / 6)) / denominator;
      return root * root;
    }
    case 'horizontalUnstable':
      return ra < RA_TURBULENT ? 0.54 * Math.pow(ra, 0.25) : 0.15 * Math.pow(ra, 1 / 3);
    case 'horizontalStable':
      return 0.27 * Math.pow(ra, 0.25);
  }
}

export function clampConvectionH(h: number): number {
  if (!Number.isFinite(h)) return H_MIN;
  return Math.min(Math.max(h, H_MIN), H_MAX);
}

export function naturalConvectionH(
  tSurface: number,
  tAmbient: number,
  regime: ConvectionRegime,
  length: number,
): number {
  const film = 0.5 * (tSurface + tAmbient);
  const air = airPropertiesAt(film);
  const l = Math.max(length, MIN_LENGTH);
  const ra = rayleighNumber(tSurface - tAmbient, l, air);
  return clampConvectionH((nusseltNumber(regime, ra, air.prandtl) * air.k) / l);
}

export interface LengthScales {
  /** Height along gravity — the vertical-plate length scale. */
  vertical: number;
  /** A/P of the footprint — the horizontal-plate length scale. */
  horizontal: number;
}

/**
 * Length scales from the part's bounding box: the extent along gravity for vertical
 * walls, and the footprint's area/perimeter for horizontal ones. A box footprint is a
 * coarse stand-in for the true face perimeter, but A/P only enters as L in Nu·k/L and
 * the correlations are quarter-power in L to begin with.
 */
export function partLengthScales(part: Part, gravity: Vec3): LengthScales {
  const g = normaliseGravity(gravity);
  const size: [number, number, number] = [
    Math.max(0, part.bbox.max[0] - part.bbox.min[0]),
    Math.max(0, part.bbox.max[1] - part.bbox.min[1]),
    Math.max(0, part.bbox.max[2] - part.bbox.min[2]),
  ];
  const vertical = Math.abs(g[0]) * size[0] + Math.abs(g[1]) * size[1] + Math.abs(g[2]) * size[2];

  // The two axes least aligned with gravity span the footprint.
  const axes = [0, 1, 2].sort((a, b) => Math.abs(g[a]) - Math.abs(g[b]));
  const a = size[axes[0]];
  const b = size[axes[1]];
  const perimeter = 2 * (a + b);
  const horizontal = perimeter > 0 ? (a * b) / perimeter : 0;

  return {
    vertical: Math.max(vertical, MIN_LENGTH),
    horizontal: Math.max(horizontal, MIN_LENGTH),
  };
}

export function normaliseGravity(gravity: Vec3): Vec3 {
  const norm = Math.hypot(gravity[0], gravity[1], gravity[2]);
  if (!(norm > 0)) return [0, 0, -1];
  return [gravity[0] / norm, gravity[1] / norm, gravity[2] / norm];
}

/**
 * Film coefficient per triangle, W/(m²·K).
 *
 * Precedence: an explicit user h (`fixedH[t]`, NaN meaning "auto") beats the cavity
 * condition, which beats the correlation. Explicit values are used as given — the
 * [H_MIN, H_MAX] clamp guards the correlation, not the user.
 */
export function computeConvectionCoefficients(
  model: ThermalModel,
  scenario: Scenario,
  temperature: Float32Array,
  fixedH: Float32Array | null = null,
  out?: Float32Array,
): Float32Array {
  const h = out && out.length === model.triCount ? out : new Float32Array(model.triCount);
  const gravity = normaliseGravity(scenario.gravity);
  const cavities = new Map<number, Cavity>(scenario.cavities.map((cavity) => [cavity.id, cavity]));

  const partScales: LengthScales[] = [];
  const partInsulated: boolean[] = [];
  for (const part of model.parts) {
    partScales.push(partLengthScales(part, gravity));
    partInsulated.push(resolvePart(part, scenario.partOverrides[part.id]).bodyType === 'insulator');
  }

  for (let t = 0; t < model.triCount; t++) {
    const part = model.triPart[t];
    if (partInsulated[part]) {
      h[t] = 0;
      continue;
    }

    const override = fixedH ? fixedH[t] : Number.NaN;
    if (!Number.isNaN(override)) {
      h[t] = Math.max(0, override);
      continue;
    }

    const cavityId = model.triCavity[t];
    if (cavityId !== 0) {
      const cavity = cavities.get(cavityId);
      if (cavity) {
        h[t] = cavity.condition === 'adiabatic' ? 0 : Math.max(0, cavity.h);
        continue;
      }
    }

    const tSurface =
      (temperature[model.tris[t * 3]] +
        temperature[model.tris[t * 3 + 1]] +
        temperature[model.tris[t * 3 + 2]]) /
      3;
    const normalDotGravity =
      model.triNormal[t * 3] * gravity[0] +
      model.triNormal[t * 3 + 1] * gravity[1] +
      model.triNormal[t * 3 + 2] * gravity[2];
    const regime = classifyConvection(normalDotGravity, tSurface, scenario.ambient);
    const scales = partScales[part];
    const length = regime === 'vertical' ? scales.vertical : scales.horizontal;
    h[t] = naturalConvectionH(tSurface, scenario.ambient, regime, length);
  }

  return h;
}
