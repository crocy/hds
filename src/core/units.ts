/**
 * Conversion at the edges of the model. Everything from `geometry/` inwards is
 * SI — metres, kelvin, watts — so CAD units are converted once, on import, and
 * display units once, in `ui/`.
 */

import type { ThermalModel } from './types';

export type LengthUnit = ThermalModel['sourceUnits'];

export const LENGTH_UNITS: readonly LengthUnit[] = ['mm', 'm', 'in'];

const METRES_PER_UNIT: Record<LengthUnit, number> = {
  mm: 1e-3,
  m: 1,
  in: 0.0254,
};

export function metresPerUnit(unit: LengthUnit): number {
  return METRES_PER_UNIT[unit];
}

export function toMetres(length: number, unit: LengthUnit): number {
  return length * METRES_PER_UNIT[unit];
}

export function fromMetres(metres: number, unit: LengthUnit): number {
  return metres / METRES_PER_UNIT[unit];
}

export function isLengthUnit(value: string): value is LengthUnit {
  return value in METRES_PER_UNIT;
}

export const ABSOLUTE_ZERO_C = -273.15;

export function celsiusToKelvin(celsius: number): number {
  return celsius - ABSOLUTE_ZERO_C;
}

export function kelvinToCelsius(kelvin: number): number {
  return kelvin + ABSOLUTE_ZERO_C;
}
