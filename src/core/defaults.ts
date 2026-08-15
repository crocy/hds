/**
 * Scenario defaults.
 *
 * Deliberately thin: material and finish ids live with the material library in
 * `physics/materials`, cavity presets with `geometry/cavity`, and the sheet
 * thinness threshold with `geometry/build`. Each constant has exactly one home,
 * next to the code that gives it meaning.
 */

import { celsiusToKelvin } from './units';
import { DEFAULT_SOLVER_SETTINGS, type Scenario, type Vec3 } from './types';

/** Z-up, matching what CAD tools export and what the reference model assumes. */
export const DEFAULT_GRAVITY: Vec3 = [0, 0, -1];

export const DEFAULT_AMBIENT_C = 20;

export function createDefaultScenario(ambientC = DEFAULT_AMBIENT_C): Scenario {
  return {
    ambient: celsiusToKelvin(ambientC),
    gravity: DEFAULT_GRAVITY,
    partOverrides: {},
    boundaryConditions: [],
    contacts: [],
    cavities: [],
    colorScale: { mode: 'auto', min: 0, max: 0, map: 'inferno' },
    solver: { ...DEFAULT_SOLVER_SETTINGS },
  };
}
