/**
 * The plots' visual constants, in one place so the five panels stay a set.
 *
 * Values track the app shell (`ui/styles.css`) and the prototype: near-black
 * background, `#e8eaf0` primary text, `#8f92a0` for anything secondary. Colours
 * that encode *magnitude* are still the shared colormap's, so a plot and the 3D
 * view always agree on what "hot" looks like; what lives here is the one rule for
 * making that colormap readable on this panel — see `markColor`.
 */

import type { ColormapId } from '@/core/types';
import { sample, type RGB } from '@/viewer/colormap';

export const PLOT_COLORS = {
  axis: '#3a3a46',
  grid: 'rgba(143, 146, 160, 0.10)',
  /** Fitted curves and annotation callouts. */
  accent: '#38bdf8',
  /** A limit the user set, and the shading tied to it. */
  threshold: '#f0554a',
  /** A comparison curve the model is being judged against. */
  reference: '#4ade80',
  contour: 'rgba(255, 255, 255, 0.7)',
  convection: '#38bdf8',
  radiation: '#f59e42',
} as const;

/**
 * The backdrop of a plot's data area. The dock is translucent over the 3D view, so
 * a plot drawn straight onto it sits on whatever the model happens to be showing;
 * filling the data area first gives every panel the reference figure's stable
 * ground, a step lighter than the app background so the colormap's dark end has
 * something to sit on.
 */
export const PLOT_PANEL = '#16161c';
/** `PLOT_PANEL` in 0..1 rgb, for the plots that fill a pixel buffer. */
export const PLOT_PANEL_RGB: RGB = [0x16 / 255, 0x16 / 255, 0x1c / 255];

/**
 * Every thermal colormap bottoms out at near-black, so a cold *mark* — a scatter
 * point, a histogram bar — drawn straight from the map disappears into
 * `PLOT_PANEL`, and a plot that shows only its hot end invites reading a fitted
 * curve nobody can check against the data. `markColor` lifts the cold end of the
 * map onto a cool grey that clears the panel, fading the lift out as the colour
 * warms so the hot end arrives untouched. Hue and order are unchanged, so a mark
 * still reads as the temperature it has in the 3D view.
 *
 * Area fills are deliberately not lifted: the cut-plane field covers the panel, has
 * nothing to separate from, and is read against its own colour ramp.
 */
const MARK_BLACK_POINT: RGB = [0.22, 0.22, 0.3];

export function markColor(map: ColormapId, t: number): RGB {
  const [r, g, b] = sample(map, t);
  const cold = 1 - (t < 0 ? 0 : t > 1 ? 1 : t);
  return [
    r + (1 - r) * MARK_BLACK_POINT[0] * cold,
    g + (1 - g) * MARK_BLACK_POINT[1] * cold,
    b + (1 - b) * MARK_BLACK_POINT[2] * cold,
  ];
}

export function markCssColor(map: ColormapId, t: number): string {
  const [r, g, b] = markColor(map, t);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

/**
 * A categorical ramp for the per-part profile lines. Deliberately *not* the thermal
 * colormap: those colours encode temperature, and reusing them for part identity
 * would make a reader think a green line is colder than an orange one.
 */
export const SERIES_COLORS: readonly string[] = [
  '#f59e42',
  '#38bdf8',
  '#a78bfa',
  '#4ade80',
  '#f472b6',
  '#facc15',
  '#60a5fa',
  '#fb923c',
];

export function seriesColor(index: number): string {
  return SERIES_COLORS[
    ((index % SERIES_COLORS.length) + SERIES_COLORS.length) % SERIES_COLORS.length
  ];
}

/**
 * Rough advance width of a string at the plot's UI font, for laying out an
 * annotation before the browser has measured it. Deliberately an estimate:
 * `placeCallout` only needs to know whether the block fits to the right.
 */
export function approximateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.55;
}
