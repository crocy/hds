/**
 * The plots' visual constants, one palette per resolved theme so the five panels
 * stay a set on either ground.
 *
 * Values track the app shell (`ui/styles.css`) and the prototype: a near-black
 * panel under `#e8eaf0` text on dark, a near-white panel under `#16171c` on light.
 * Colours that encode *magnitude* are still the shared colormap's, so a plot and
 * the 3D view always agree on what "hot" looks like; what lives here is the one
 * rule for making that colormap readable on whichever panel it lands on — see
 * `markColor`.
 *
 * React-free, so the rasterisers that import it stay unit-testable in Node.
 * Components reach a palette through `usePlotPalette`.
 */

import type { ColormapId } from '@/core/types';
import { sample, type RGB } from '@/viewer/colormap';
import type { ResolvedTheme } from '@/ui/theme';
// Deep import: the `@/ui/theme` barrel carries the React binding, which the pure plot modules stay clear of.
import { parseHexColor } from '@/ui/theme/contrast';

/**
 * How a mark drawn from the colormap is pulled clear of the panel it sits on.
 * Per channel, `out = c + (target - c) * strength * weight`.
 */
export interface MarkContrast {
  /** The pole to blend toward: 1 (white) on a dark panel, 0 (black) on a light one. */
  target: 0 | 1;
  /** Per-channel blend strength at the far end of the ramp. */
  strength: RGB;
  /** Which end needs the pull. */
  end: 'cold' | 'hot';
}

export interface PlotPalette {
  /** The data area's frame and its ticks. */
  axis: string;
  grid: string;
  /** Fitted curves and annotation callouts. */
  accent: string;
  /** A limit the user set, and the shading tied to it. */
  threshold: string;
  /** A comparison curve the model is being judged against. */
  reference: string;
  contour: string;
  convection: string;
  radiation: string;
  /**
   * Histogram bars carry the colormap lifted off the panel (`markColor`); this
   * hairline is what still separates two neighbouring bins of nearly the same
   * temperature.
   */
  barEdge: string;
  /**
   * The backdrop of a plot's data area. The dock is translucent over the 3D view,
   * so a plot drawn straight onto it sits on whatever the model happens to be
   * showing; filling the data area first gives every panel the reference figure's
   * stable ground — a step lighter than the app background on dark, a step darker
   * on light, so the end of the colormap at risk has something to sit on.
   */
  panel: string;
  /** `panel` in 0..1 rgb, for the plots that fill a pixel buffer. */
  panelRgb: RGB;
  mark: MarkContrast;
  /** The categorical ramp for per-part profile lines, read through `seriesColor`. */
  series: readonly string[];
}

const DARK_PANEL = '#16161c';
const LIGHT_PANEL = '#e6e8ec';

/**
 * A categorical ramp for the per-part profile lines. Deliberately *not* the thermal
 * colormap: those colours encode temperature, and reusing them for part identity
 * would make a reader think a green line is colder than an orange one.
 *
 * One set per theme, paired index for index so a part keeps its hue family — and so
 * its identity — across a theme switch. The dark eight are tuned to glow on
 * near-black and measure 1.25 to 2.22 against the light panel: being distinguishable
 * from *each other* is not their only job, they also have to be visible, so light
 * theme gets its own darkened set rather than inheriting these.
 */
const DARK_SERIES_COLORS: readonly string[] = [
  '#f59e42',
  '#38bdf8',
  '#a78bfa',
  '#4ade80',
  '#f472b6',
  '#facc15',
  '#60a5fa',
  '#fb923c',
];

const LIGHT_SERIES_COLORS: readonly string[] = [
  '#b45309',
  '#0369a1',
  '#6d28d9',
  '#15803d',
  '#be185d',
  '#a16207',
  '#1d4ed8',
  '#c2410c',
];

const PLOT_PALETTES: Record<ResolvedTheme, PlotPalette> = {
  dark: {
    axis: '#3a3a46',
    grid: 'rgba(143, 146, 160, 0.10)',
    accent: '#38bdf8',
    threshold: '#f0554a',
    reference: '#4ade80',
    contour: 'rgba(255, 255, 255, 0.7)',
    convection: '#38bdf8',
    radiation: '#f59e42',
    barEdge: 'rgba(232, 234, 240, 0.22)',
    panel: DARK_PANEL,
    panelRgb: parseHexColor(DARK_PANEL),
    mark: { target: 1, strength: [0.22, 0.22, 0.3], end: 'cold' },
    series: DARK_SERIES_COLORS,
  },
  light: {
    axis: '#a8acb6',
    grid: 'rgba(92, 96, 108, 0.14)',
    accent: '#0369a1',
    threshold: '#c2362b',
    reference: '#15803d',
    contour: 'rgba(20, 21, 26, 0.65)',
    convection: '#0369a1',
    radiation: '#b45309',
    barEdge: 'rgba(20, 21, 26, 0.22)',
    panel: LIGHT_PANEL,
    panelRgb: parseHexColor(LIGHT_PANEL),
    mark: { target: 0, strength: [0.32, 0.32, 0.38], end: 'hot' },
    series: LIGHT_SERIES_COLORS,
  },
};

/** One shared object per theme, so a palette is safe to use as a memo or effect dependency. */
export function plotPalette(resolved: ResolvedTheme): PlotPalette {
  return PLOT_PALETTES[resolved];
}

/**
 * Every thermal colormap runs from near-black to near-white, so whichever pole the
 * panel sits at, a *mark* — a scatter point, a histogram bar — drawn straight from
 * the map at that end vanishes into it, and a plot that shows only its other end
 * invites reading a fitted curve nobody can check against the data. `markColor`
 * blends the end at risk toward the opposite pole — white on the dark panel, black
 * on the light one — fading the blend out across the ramp so the safe end arrives
 * untouched. Hue and order are unchanged in both themes, so a mark still reads as
 * the temperature it has in the 3D view.
 *
 * Area fills are deliberately not lifted, in either theme: the cut-plane field
 * covers the panel, has nothing to separate from, and is read against its own ramp.
 */
export function markColor(map: ColormapId, t: number, contrast: MarkContrast): RGB {
  const [r, g, b] = sample(map, t);
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const weight = contrast.end === 'cold' ? 1 - clamped : clamped;
  const { target, strength } = contrast;
  return [
    r + (target - r) * strength[0] * weight,
    g + (target - g) * strength[1] * weight,
    b + (target - b) * strength[2] * weight,
  ];
}

export function markCssColor(map: ColormapId, t: number, contrast: MarkContrast): string {
  const [r, g, b] = markColor(map, t, contrast);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

/** Wraps, so a model with more parts than hues reuses them instead of running out. */
export function seriesColor(index: number, series: readonly string[]): string {
  return series[((index % series.length) + series.length) % series.length];
}

/**
 * Rough advance width of a string at the plot's UI font, for laying out an
 * annotation before the browser has measured it. Deliberately an estimate:
 * `placeCallout` only needs to know whether the block fits to the right.
 */
export function approximateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.55;
}
