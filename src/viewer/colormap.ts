/**
 * Colormaps for the shaded mesh, the legend and the 2D section field.
 *
 * Pure — no three.js — so it is unit-testable in Node and can be shared with the
 * plot code. Each map is a table of uniformly spaced control points in sRGB 0..1
 * with linear interpolation between them, which is what the prototype did and is
 * visually indistinguishable from the 256-entry originals at legend scale.
 */

import type { ColormapId, ColorScale } from '@/core/types';

export type RGB = [number, number, number];

/** From the prototype — the reference image is shaded with exactly these stops. */
const INFERNO: readonly RGB[] = [
  [0.0015, 0.0005, 0.0139],
  [0.0872, 0.0448, 0.2226],
  [0.2582, 0.0386, 0.4069],
  [0.4168, 0.0906, 0.4328],
  [0.578, 0.148, 0.4044],
  [0.7355, 0.2154, 0.3306],
  [0.8654, 0.3169, 0.226],
  [0.9545, 0.4682, 0.0993],
  [0.9871, 0.652, 0.0212],
  [0.964, 0.8433, 0.2735],
  [0.9884, 0.9983, 0.6449],
];

const VIRIDIS: readonly RGB[] = [
  [0.267, 0.0049, 0.3294],
  [0.2826, 0.1409, 0.4575],
  [0.2539, 0.2653, 0.53],
  [0.2068, 0.3718, 0.5531],
  [0.1636, 0.4711, 0.5581],
  [0.1276, 0.5669, 0.5506],
  [0.1347, 0.6586, 0.5176],
  [0.2669, 0.7488, 0.4406],
  [0.4775, 0.8214, 0.3182],
  [0.7414, 0.8734, 0.1496],
  [0.9932, 0.9062, 0.1439],
];

const TURBO: readonly RGB[] = [
  [0.1882, 0.0706, 0.2314],
  [0.2549, 0.2706, 0.6706],
  [0.2745, 0.4588, 0.9294],
  [0.2235, 0.6353, 0.9882],
  [0.1059, 0.8118, 0.8314],
  [0.1412, 0.9255, 0.651],
  [0.3804, 0.9882, 0.4235],
  [0.6431, 0.9882, 0.2314],
  [0.8196, 0.9098, 0.2039],
  [0.9529, 0.7765, 0.2275],
  [0.9961, 0.6078, 0.1765],
  [0.9529, 0.3882, 0.0824],
  [0.851, 0.2196, 0.0235],
  [0.6941, 0.098, 0.0039],
  [0.4784, 0.0157, 0.0118],
];

/**
 * Moreland cool–warm. Diverging: the pale midpoint sits at t = 0.5, so a scale
 * centred on ambient renders everything above ambient warm and everything below
 * it cool. See `resolveScaleRange`.
 */
const COOLWARM: readonly RGB[] = [
  [0.2298, 0.2987, 0.7537],
  [0.3667, 0.4885, 0.9052],
  [0.4839, 0.6221, 0.9748],
  [0.622, 0.7462, 0.9989],
  [0.7536, 0.83, 0.9613],
  [0.8654, 0.8654, 0.8654],
  [0.9473, 0.7947, 0.717],
  [0.9687, 0.6767, 0.5597],
  [0.9319, 0.5191, 0.4064],
  [0.8474, 0.3298, 0.2609],
  [0.7057, 0.0156, 0.1502],
];

const TABLES: Record<ColormapId, readonly RGB[]> = {
  inferno: INFERNO,
  viridis: VIRIDIS,
  turbo: TURBO,
  coolwarm: COOLWARM,
};

export const COLORMAP_IDS: readonly ColormapId[] = ['inferno', 'viridis', 'turbo', 'coolwarm'];

export const COLORMAP_LABELS: Record<ColormapId, string> = {
  inferno: 'inferno',
  viridis: 'viridis',
  turbo: 'turbo',
  coolwarm: 'cool–warm (diverging)',
};

const DIVERGING: ReadonlySet<ColormapId> = new Set<ColormapId>(['coolwarm']);

/** Diverging maps are only readable on a range symmetric about their centre value. */
export function isDiverging(map: ColormapId): boolean {
  return DIVERGING.has(map);
}

function tableOf(map: ColormapId): readonly RGB[] {
  return TABLES[map] ?? INFERNO;
}

function clamp01(t: number): number {
  if (!Number.isFinite(t)) return 0;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Colour at position `t` along the map. `t` outside [0,1] is clamped; NaN reads as 0. */
export function sample(map: ColormapId, t: number): RGB {
  const table = tableOf(map);
  const scaled = clamp01(t) * (table.length - 1);
  const lower = Math.min(table.length - 2, Math.floor(scaled));
  const f = scaled - lower;
  const a = table[lower];
  const b = table[lower + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** IEC 61966-2-1 sRGB → linear, for feeding a colour-managed renderer. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Maps a value onto [0,1] for the given range. A degenerate range reads as the midpoint. */
export function normalize(value: number, min: number, max: number): number {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return 0.5;
  return clamp01((value - min) / span);
}

export interface VertexColorOptions {
  /**
   * Convert to linear-sRGB. three.js works in a linear space with colour
   * management on, so vertex colours must be linearised to display as authored.
   */
  linear?: boolean;
}

/**
 * Writes one rgb triple per value into `out` (length 3 × values.length).
 * In-place typed-array write: this runs on every solve and every scale change.
 */
export function writeVertexColors(
  values: ArrayLike<number>,
  min: number,
  max: number,
  map: ColormapId,
  out: Float32Array,
  options: VertexColorOptions = {},
): void {
  const table = tableOf(map);
  const last = table.length - 1;
  const span = max - min;
  const invSpan = Number.isFinite(span) && span > 0 ? 1 / span : 0;
  const linear = options.linear === true;

  for (let i = 0; i < values.length; i++) {
    const t = invSpan === 0 ? 0.5 : clamp01((values[i] - min) * invSpan);
    const scaled = t * last;
    const lower = Math.min(last - 1, Math.floor(scaled));
    const f = scaled - lower;
    const a = table[lower];
    const b = table[lower + 1];
    let r = a[0] + (b[0] - a[0]) * f;
    let g = a[1] + (b[1] - a[1]) * f;
    let bl = a[2] + (b[2] - a[2]) * f;
    if (linear) {
      r = srgbToLinear(r);
      g = srgbToLinear(g);
      bl = srgbToLinear(bl);
    }
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = bl;
  }
}

/** Writes RGBA bytes, for a DataTexture. NaN values become fully transparent. */
export function writeRgbaBytes(
  values: ArrayLike<number>,
  min: number,
  max: number,
  map: ColormapId,
  out: Uint8Array,
): void {
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) {
      out[i * 4] = 0;
      out[i * 4 + 1] = 0;
      out[i * 4 + 2] = 0;
      out[i * 4 + 3] = 0;
      continue;
    }
    const [r, g, b] = sample(map, normalize(value, min, max));
    out[i * 4] = Math.round(r * 255);
    out[i * 4 + 1] = Math.round(g * 255);
    out[i * 4 + 2] = Math.round(b * 255);
    out[i * 4 + 3] = 255;
  }
}

export function cssColor(map: ColormapId, t: number): string {
  const [r, g, b] = sample(map, t);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

/** `linear-gradient(...)` for the legend bar. */
export function gradientCss(map: ColormapId, stops = 24, direction = '90deg'): string {
  const steps = Math.max(2, Math.floor(stops));
  const parts: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    parts.push(`${cssColor(map, t)} ${(t * 100).toFixed(2)}%`);
  }
  return `linear-gradient(${direction}, ${parts.join(', ')})`;
}

/** The smallest range around `center` that still covers [min, max]. */
export function symmetricRange(min: number, max: number, center: number): [number, number] {
  const half = Math.max(Math.abs(max - center), Math.abs(center - min));
  return [center - half, center + half];
}

const MIN_SCALE_SPAN = 1e-3;

/**
 * Turns a `ColorScale` plus the solved field into the concrete [min, max] the
 * mesh and the legend are shaded with.
 *
 * `manual` is honoured verbatim — including for a diverging map, where the user
 * asked for those numbers. `auto` and `ambientToMax` are re-centred on ambient
 * for diverging maps, which is the whole reason that map exists.
 */
export function resolveScaleRange(
  scale: ColorScale,
  values: ArrayLike<number> | null,
  ambient: number,
): [number, number] {
  let min = scale.min;
  let max = scale.max;

  if (scale.mode !== 'manual') {
    let dataMin = Infinity;
    let dataMax = -Infinity;
    if (values) {
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        if (v < dataMin) dataMin = v;
        if (v > dataMax) dataMax = v;
      }
    }
    if (dataMin > dataMax) {
      dataMin = ambient - 0.5;
      dataMax = ambient + 0.5;
    }
    min = scale.mode === 'ambientToMax' ? ambient : dataMin;
    max = dataMax;
    if (isDiverging(scale.map)) [min, max] = symmetricRange(min, max, ambient);
  }

  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < MIN_SCALE_SPAN) {
    const centre = Number.isFinite(min) ? min : ambient;
    return [centre - MIN_SCALE_SPAN / 2, centre + MIN_SCALE_SPAN / 2];
  }
  return [min, max];
}
