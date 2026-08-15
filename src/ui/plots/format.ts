/**
 * Display formatting for the plots. The solver works in SI — metres, kelvin,
 * watts, m² — and every one of those is unreadable on an axis, so the conversion
 * to mm, °C and cm² happens here and only here. No kelvin number reaches a label.
 */

import { kelvinToCelsius } from '@/core/units';

const MM_PER_METRE = 1000;
const CM2_PER_M2 = 1e4;

export function metresToMillimetres(metres: number): number {
  return metres * MM_PER_METRE;
}

export function squareMetresToSquareCentimetres(area: number): number {
  return area * CM2_PER_M2;
}

/** A dash, not "NaN" — a missing number should read as absent rather than broken. */
export const NO_VALUE = '—';

export function formatFixed(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return NO_VALUE;
  // -0 prints as "-0"; normalising the sign avoids a bogus minus on a zero tick.
  const normalised = value === 0 ? 0 : value;
  return normalised.toFixed(Math.max(0, Math.min(20, decimals)));
}

export function formatCelsius(kelvin: number, decimals = 0): string {
  return formatFixed(kelvinToCelsius(kelvin), decimals);
}

export function formatCelsiusWithUnit(kelvin: number, decimals = 0): string {
  const text = formatCelsius(kelvin, decimals);
  return text === NO_VALUE ? text : `${text} °C`;
}

export function formatMillimetres(metres: number, decimals = 0): string {
  return formatFixed(metresToMillimetres(metres), decimals);
}

export function formatMillimetresWithUnit(metres: number, decimals = 0): string {
  const text = formatMillimetres(metres, decimals);
  return text === NO_VALUE ? text : `${text} mm`;
}

/** Three significant figures, but never scientific notation and never a bare "0.0000012". */
function significant(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return NO_VALUE;
  if (value === 0) return '0';
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const decimals = Math.max(0, Math.min(6, digits - 1 - magnitude));
  return value.toFixed(decimals);
}

/**
 * Watts, rescaled so a 61 W loss and a 0.4 mW residual are both readable. Anything
 * under a microwatt is reported as zero rather than as a string of zeroes.
 */
export function formatWatts(watts: number): string {
  if (!Number.isFinite(watts)) return NO_VALUE;
  const magnitude = Math.abs(watts);
  if (magnitude < 1e-6) return '0 W';
  if (magnitude < 1e-3) return `${significant(watts * 1e6)} µW`;
  if (magnitude < 1) return `${significant(watts * 1e3)} mW`;
  if (magnitude < 1e3) return `${significant(watts)} W`;
  return `${significant(watts / 1e3)} kW`;
}

/** Surface area in cm², the unit the "X cm² above 55 °C" figure is quoted in. */
export function formatSquareCentimetres(squareMetres: number): string {
  if (!Number.isFinite(squareMetres)) return NO_VALUE;
  const cm2 = squareMetresToSquareCentimetres(squareMetres);
  if (cm2 !== 0 && Math.abs(cm2) < 0.1) return '<0.1 cm²';
  return `${significant(cm2, 3)} cm²`;
}

export function formatPercent(fraction: number, decimals = 0): string {
  if (!Number.isFinite(fraction)) return NO_VALUE;
  return `${(fraction * 100).toFixed(decimals)}%`;
}

/** Goodness of fit, printed as `r² = 0.982`. */
export function formatRSquared(rSquared: number): string {
  if (!Number.isFinite(rSquared)) return `r² ${NO_VALUE}`;
  return `r² = ${rSquared.toFixed(3)}`;
}

/**
 * The fitted decay written the way the reference figure writes it:
 * `35 + 160·e^(−s/46 mm)`, in °C and mm.
 */
export function formatDecayExpression(fit: {
  lambda: number;
  tInfinity: number;
  deltaT: number;
}): string {
  const asymptote = formatCelsius(fit.tInfinity, 0);
  const amplitude = significant(fit.deltaT, 3);
  const lambda = formatMillimetres(fit.lambda, fit.lambda < 0.01 ? 1 : 0);
  return `${asymptote} + ${amplitude}·e^(−s/${lambda} mm)`;
}

export function formatLambda(lambda: number): string {
  return `λ = ${formatMillimetresWithUnit(lambda, lambda < 0.01 ? 1 : 0)}`;
}
