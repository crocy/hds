/**
 * The maths behind every plot: domains, round tick values, and the affine maps
 * from data space to pixels.
 *
 * Pure and DOM-free, so it is unit-testable in Node. Component rendering is not
 * testable here, so anything that can go wrong numerically — a degenerate domain,
 * an all-Infinity distance array, a threshold above every sample — is decided in
 * this file rather than inside a component.
 */

export interface Interval {
  min: number;
  max: number;
}

export interface PlotMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The data rectangle in CSS pixels, inside the margins. */
export interface PlotArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An affine map from data values to pixels. `rangeMin > rangeMax` inverts it, as a y axis needs. */
export interface LinearScale {
  domainMin: number;
  domainMax: number;
  rangeMin: number;
  rangeMax: number;
}

export const DEFAULT_PLOT_MARGINS: PlotMargins = { top: 10, right: 14, bottom: 38, left: 54 };

/** Anything wider than this is a bug in the caller's domain, not a legible axis. */
const MAX_TICKS = 200;

/**
 * Allowed step mantissas, with the geometric midpoint that separates each from
 * the next. Geometric rather than arithmetic so that "1.5x too coarse" and
 * "1.5x too fine" are treated as equally wrong.
 */
const NICE_MANTISSAS: ReadonlyArray<{ upTo: number; mantissa: number }> = [
  { upTo: Math.SQRT2, mantissa: 1 },
  { upTo: Math.sqrt(5), mantissa: 2 },
  { upTo: Math.sqrt(12.5), mantissa: 2.5 },
  { upTo: Math.sqrt(50), mantissa: 5 },
];

/**
 * The nearest round step to `raw`: 1, 2, 2.5 or 5 times a power of ten. 2.5 is
 * included because temperature axes read naturally in 25 °C steps.
 *
 * Nearest, not rounded up: rounding up costs roughly a third of the requested
 * ticks whenever the raw step lands just above a round value, which on a 200 °C
 * axis is the difference between labelling every 25 °C and every 50 °C.
 */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const mantissa = raw / magnitude;
  for (const candidate of NICE_MANTISSAS) {
    if (mantissa < candidate.upTo) return candidate.mantissa * magnitude;
  }
  return 10 * magnitude;
}

/** Decimal places needed to print `step` and its multiples without losing the step. */
export function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  let decimals = Math.max(0, -Math.floor(Math.log10(step)));
  // A 2.5-style step needs one more place than its magnitude alone suggests.
  while (
    decimals < 9 &&
    Math.abs(step * 10 ** decimals - Math.round(step * 10 ** decimals)) > 1e-9
  ) {
    decimals++;
  }
  return decimals;
}

/** Decimal places that keep every tick distinguishable from its neighbour. */
export function decimalsForTicks(ticks: readonly number[]): number {
  if (ticks.length < 2) return ticks.length === 1 && !Number.isInteger(ticks[0]) ? 2 : 0;
  let smallestGap = Infinity;
  for (let i = 1; i < ticks.length; i++) {
    const gap = Math.abs(ticks[i] - ticks[i - 1]);
    if (gap > 0 && gap < smallestGap) smallestGap = gap;
  }
  return Number.isFinite(smallestGap) ? decimalsForStep(smallestGap) : 0;
}

/** Snaps off the float noise that `index * step` accumulates. */
function snap(value: number): number {
  return Number(value.toPrecision(12));
}

/**
 * Round tick values inside [min, max]. Returns `[]` for a non-finite domain and a
 * single tick for a zero-width one, so an axis never renders a NaN label.
 */
export function generateTicks(min: number, max: number, targetCount = 6): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  if (high === low) return [snap(low)];

  const step = niceStep((high - low) / Math.max(2, Math.floor(targetCount)));
  if (!(step > 0)) return [snap(low)];

  const first = Math.ceil(low / step - 1e-9);
  const last = Math.floor(high / step + 1e-9);
  const ticks: number[] = [];
  for (let i = first; i <= last && ticks.length < MAX_TICKS; i++) ticks.push(snap(i * step));
  return ticks;
}

/** Expands [min, max] outward to the nearest round step, so the axis ends on a labelled tick. */
export function niceInterval(min: number, max: number, targetCount = 6): Interval {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  if (high === low) return { min: low - 0.5, max: low + 0.5 };
  const step = niceStep((high - low) / Math.max(2, Math.floor(targetCount)));
  return { min: snap(Math.floor(low / step) * step), max: snap(Math.ceil(high / step) * step) };
}

/** Widens an interval just enough to contain `value`. A non-finite value is ignored. */
export function includeInInterval(interval: Interval, value: number): Interval {
  if (!Number.isFinite(value)) return interval;
  return { min: Math.min(interval.min, value), max: Math.max(interval.max, value) };
}

/** Extent of the finite entries. Null when there are none — the caller's empty-state signal. */
export function finiteExtent(values: ArrayLike<number>): Interval | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? { min, max } : null;
}

export interface PairExtent {
  x: Interval;
  y: Interval;
  /** Points where both coordinates are finite — what the scatter will actually draw. */
  count: number;
}

/**
 * Extent over the points where *both* coordinates are finite. Nodes the conduction
 * graph never reached carry an infinite distance, and letting those through would
 * stretch the axis to infinity.
 */
export function finitePairExtent(x: ArrayLike<number>, y: ArrayLike<number>): PairExtent | null {
  const length = Math.min(x.length, y.length);
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let count = 0;
  for (let i = 0; i < length; i++) {
    const xi = x[i];
    const yi = y[i];
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
    count++;
    if (xi < xMin) xMin = xi;
    if (xi > xMax) xMax = xi;
    if (yi < yMin) yMin = yi;
    if (yi > yMax) yMax = yi;
  }
  return count > 0 ? { x: { min: xMin, max: xMax }, y: { min: yMin, max: yMax }, count } : null;
}

export function makeScale(domain: Interval, rangeMin: number, rangeMax: number): LinearScale {
  return { domainMin: domain.min, domainMax: domain.max, rangeMin, rangeMax };
}

/** A zero-width domain maps everything to the middle of the range rather than to NaN. */
export function scaleValue(scale: LinearScale, value: number): number {
  const span = scale.domainMax - scale.domainMin;
  if (!Number.isFinite(span) || span === 0) return (scale.rangeMin + scale.rangeMax) / 2;
  return scale.rangeMin + ((value - scale.domainMin) / span) * (scale.rangeMax - scale.rangeMin);
}

/**
 * The same pixel mapping expressed over raw values, where `display = raw · mul + add`.
 * Lets a plot label its axis in mm or °C while feeding the rasteriser the SI arrays
 * it already has, instead of allocating a converted copy of 100k elements.
 */
export function scaleOverRawUnits(display: LinearScale, mul: number, add: number): LinearScale {
  if (!Number.isFinite(mul) || mul === 0) return display;
  return {
    domainMin: (display.domainMin - add) / mul,
    domainMax: (display.domainMax - add) / mul,
    rangeMin: display.rangeMin,
    rangeMax: display.rangeMax,
  };
}

export interface PlotGeometry {
  /** Size of the plot body in CSS pixels, margins included. */
  width: number;
  height: number;
  area: PlotArea;
  x: LinearScale;
  y: LinearScale;
  px(value: number): number;
  py(value: number): number;
}

export interface PlotGeometryOptions {
  /**
   * Give both axes the same pixels-per-unit and centre the result. Required for a
   * plot of physical space — a cut plane stretched to fill its panel shows a shape
   * the part does not have.
   */
  equalAxisScale?: boolean;
}

/**
 * Shrinks an area to the aspect ratio of the data it holds and re-centres it, so
 * one unit measures the same in x as in y.
 */
export function fitAreaToAspect(area: PlotArea, xSpan: number, ySpan: number): PlotArea {
  if (!(xSpan > 0) || !(ySpan > 0)) return area;
  const scale = Math.min(area.width / xSpan, area.height / ySpan);
  const width = xSpan * scale;
  const height = ySpan * scale;
  if (!(width > 0) || !(height > 0)) return area;
  return {
    x: area.x + (area.width - width) / 2,
    y: area.y + (area.height - height) / 2,
    width,
    height,
  };
}

/**
 * Null until the container has been measured, or when the margins leave no room —
 * the caller renders its empty state rather than an axis with a negative length.
 */
export function computePlotGeometry(
  width: number,
  height: number,
  margins: PlotMargins,
  xDomain: Interval,
  yDomain: Interval,
  options: PlotGeometryOptions = {},
): PlotGeometry | null {
  const areaWidth = width - margins.left - margins.right;
  const areaHeight = height - margins.top - margins.bottom;
  if (!(areaWidth > 0) || !(areaHeight > 0)) return null;

  let area: PlotArea = { x: margins.left, y: margins.top, width: areaWidth, height: areaHeight };
  if (options.equalAxisScale) {
    area = fitAreaToAspect(area, xDomain.max - xDomain.min, yDomain.max - yDomain.min);
  }
  const x = makeScale(xDomain, area.x, area.x + area.width);
  const y = makeScale(yDomain, area.y + area.height, area.y);
  return {
    width,
    height,
    area,
    x,
    y,
    px: (value: number) => scaleValue(x, value),
    py: (value: number) => scaleValue(y, value),
  };
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export interface ExponentialDecay {
  /** Fin length λ, metres. */
  lambda: number;
  tInfinity: number;
  deltaT: number;
}

export function evaluateDecay(fit: ExponentialDecay, s: number): number {
  return fit.tInfinity + fit.deltaT * Math.exp(-s / fit.lambda);
}

/**
 * The fitted curve as interleaved (s, T) pairs in SI. Empty for a non-positive λ,
 * which is a fit that failed rather than a curve worth drawing.
 */
export function sampleDecayCurve(
  fit: ExponentialDecay,
  from: number,
  to: number,
  count = 128,
): Float64Array {
  if (!Number.isFinite(fit.lambda) || fit.lambda <= 0) return new Float64Array(0);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return new Float64Array(0);
  const steps = Math.max(2, Math.floor(count));
  const out = new Float64Array(steps * 2);
  for (let i = 0; i < steps; i++) {
    const s = from + ((to - from) * i) / (steps - 1);
    out[i * 2] = s;
    out[i * 2 + 1] = evaluateDecay(fit, s);
  }
  return out;
}

export interface StackSegment {
  value: number;
  /** Fraction of the stack's total magnitude, 0..1. */
  start: number;
  end: number;
}

/**
 * Cumulative fractions for a stacked bar. Widths use |value| so a part that gains
 * heat still occupies a visible segment instead of shortening the bar.
 */
export function stackSegments(values: readonly number[]): StackSegment[] {
  let total = 0;
  for (const value of values) if (Number.isFinite(value)) total += Math.abs(value);
  if (!(total > 0)) return values.map((value) => ({ value, start: 0, end: 0 }));

  const segments: StackSegment[] = [];
  let cursor = 0;
  for (const value of values) {
    const width = Number.isFinite(value) ? Math.abs(value) / total : 0;
    segments.push({ value, start: cursor, end: cursor + width });
    cursor += width;
  }
  return segments;
}

export type ResidualSeverity = 'ok' | 'warn' | 'bad';

export const RESIDUAL_WARN_FRACTION = 0.005;
export const RESIDUAL_BAD_FRACTION = 0.02;
/** Below this the residual is float noise on a model with no power in it. */
const RESIDUAL_FLOOR_WATTS = 1e-9;

/**
 * How loudly to shout about an energy imbalance, relative to the power actually
 * moving through the model. A non-finite residual is always 'bad'.
 */
export function residualSeverity(residual: number, reference: number): ResidualSeverity {
  if (!Number.isFinite(residual)) return 'bad';
  const magnitude = Math.abs(residual);
  if (magnitude <= RESIDUAL_FLOOR_WATTS) return 'ok';
  const scale = Number.isFinite(reference) ? Math.abs(reference) : 0;
  if (scale <= RESIDUAL_FLOOR_WATTS) return 'bad';
  const fraction = magnitude / scale;
  if (fraction < RESIDUAL_WARN_FRACTION) return 'ok';
  if (fraction < RESIDUAL_BAD_FRACTION) return 'warn';
  return 'bad';
}

export interface CalloutPlacement {
  /** Top-left of the text block. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where the leader line meets the block: the point on its edge nearest the node. */
  leaderX: number;
  leaderY: number;
}

/**
 * Places an annotation's text block near the point it labels: up and to the right
 * by preference, mirrored to the left when that would overflow, and clamped into
 * the plot area when neither side has room.
 *
 * The leader attaches to whichever edge of the block faces the point, so a block
 * that had to be clamped past its point still reads as pointing at it rather than
 * away from it.
 */
export function placeCallout(
  pointX: number,
  pointY: number,
  area: PlotArea,
  textWidth: number,
  textHeight: number,
  offset = { x: 26, y: 34 },
): CalloutPlacement {
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  const width = Math.min(textWidth, area.width);
  const height = Math.min(textHeight, area.height);

  const preferred = pointX + offset.x;
  const left = clamp(
    preferred + width <= right ? preferred : pointX - offset.x - width,
    area.x,
    Math.max(area.x, right - width),
  );
  const top = clamp(pointY - offset.y - height, area.y, Math.max(area.y, bottom - height));

  return {
    x: left,
    y: top,
    width,
    height,
    leaderX: clamp(pointX, left, left + width),
    leaderY: clamp(pointY, top, top + height),
  };
}
