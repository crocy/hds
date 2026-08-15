/**
 * The display boundary. Everything below the UI is SI — metres, kelvin, watts — and
 * every label the user reads comes through one of these, so a kelvin value can never
 * reach a °C field by accident.
 */

import type { Vec3 } from '@/core/types';
import { kelvinToCelsius } from '@/core/units';

export function formatCelsius(kelvin: number, digits = 1): string {
  if (!Number.isFinite(kelvin)) return '—';
  return `${kelvinToCelsius(kelvin).toFixed(digits)} °C`;
}

export function formatWatts(watts: number, digits = 2): string {
  if (!Number.isFinite(watts)) return '—';
  if (Math.abs(watts) < 1) return `${(watts * 1000).toFixed(0)} mW`;
  return `${watts.toFixed(digits)} W`;
}

/** Metres → mm, which is what CAD dimensions are quoted in. */
export function formatMillimetres(metres: number, digits = 2): string {
  if (!Number.isFinite(metres)) return '—';
  return `${(metres * 1000).toFixed(digits)} mm`;
}

/** A point in metres as the millimetre triple CAD quotes, e.g. "21.7, -177.5, 171.1 mm". */
export function formatPointMillimetres(point: Vec3, digits = 1): string {
  if (!point.every(Number.isFinite)) return '—';
  return `${point.map((axis) => (axis * 1000).toFixed(digits)).join(', ')} mm`;
}

export function formatArea(squareMetres: number): string {
  if (!Number.isFinite(squareMetres)) return '—';
  if (squareMetres < 1e-4) return `${(squareMetres * 1e6).toFixed(1)} mm²`;
  if (squareMetres < 1) return `${(squareMetres * 1e4).toFixed(2)} cm²`;
  return `${squareMetres.toFixed(3)} m²`;
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

/** Parses a user-typed number, returning null for anything that is not one. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}
