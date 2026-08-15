/**
 * The plots' visual constants, in one place so the five panels stay a set.
 *
 * Values track the app shell (`ui/styles.css`) and the prototype: near-black
 * background, `#e8eaf0` primary text, `#8f92a0` for anything secondary. Colours
 * that encode *magnitude* never appear here — those come from the shared
 * colormap, so a plot and the 3D view always agree on what "hot" looks like.
 */

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
