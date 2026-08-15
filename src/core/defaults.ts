/**
 * Default scenario values and the canonical material/finish ids that import
 * assigns before the user picks anything.
 */

import {
  DEFAULT_SOLVER_SETTINGS,
  type Cavity,
  type CavityCondition,
  type Scenario,
  type Vec3,
} from './types';

export const DEFAULT_MATERIAL_ID = 'ss304';
export const DEFAULT_FINISH_ID = 'bare-metal';

/** 1 mm — the sheet thickness of the reference TBTE housing. */
export const DEFAULT_THICKNESS = 0.001;

export const KELVIN_OFFSET = 273.15;

/** Below this thinness ratio a part is guessed to be sheet rather than bulk. */
export const SHEET_THINNESS_THRESHOLD = 0.3;

/** Z-up, matching the STEP files CAD tools export and the prototype's camera. */
export const DEFAULT_GRAVITY: Vec3 = [0, 0, -1];

interface CavityPreset {
  /** Effective film coefficient for surfaces facing the cavity, W/(m²·K). */
  h: number;
  /** Reduced emissivity for the enclosure approximation. */
  emissivity: number;
  /** Conductivity of the fill, W/(m·K) — consumed by the 2D cut-plane solve. */
  fillK: number;
}

export const CAVITY_PRESETS: Record<CavityCondition, CavityPreset> = {
  // Trapped air still moves, just far less than open air does.
  stillAir: { h: 3, emissivity: 0.6, fillK: 0.026 },
  insulated: { h: 0.5, emissivity: 0.2, fillK: 0.04 },
  adiabatic: { h: 0, emissivity: 0, fillK: 0.0001 },
};

export function makeCavity(id: number, condition: CavityCondition, triCount: number): Cavity {
  const preset = CAVITY_PRESETS[condition];
  return {
    id,
    name: `cavity ${id}`,
    condition,
    h: preset.h,
    emissivity: preset.emissivity,
    fillK: preset.fillK,
    triCount,
  };
}

export function createDefaultScenario(ambientC = 20): Scenario {
  return {
    ambient: ambientC + KELVIN_OFFSET,
    gravity: DEFAULT_GRAVITY,
    partOverrides: {},
    boundaryConditions: [],
    contacts: [],
    cavities: [],
    colorScale: { mode: 'auto', min: 0, max: 0, map: 'inferno' },
    solver: { ...DEFAULT_SOLVER_SETTINGS },
  };
}
