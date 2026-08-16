import { describe, expect, it } from 'vitest';
import { contrastRatio, parseHexColor, type RGB } from '@/ui/theme';
import { COLORMAP_IDS, sample } from '@/viewer/colormap';
import { markColor, markCssColor, plotPalette, seriesColor, type PlotPalette } from './theme';

const DARK = plotPalette('dark');
const LIGHT = plotPalette('light');

const SAMPLE_POSITIONS = [0, 0.15, 0.25, 0.5, 0.75, 0.9, 1];

/**
 * The expression `markColor` carried before the palette was split per theme, kept
 * verbatim: dark theme's output has to reproduce it, not merely resemble it.
 */
const LEGACY_BLACK_POINT: RGB = [0.22, 0.22, 0.3];

function legacyMarkColor(map: (typeof COLORMAP_IDS)[number], t: number): RGB {
  const [r, g, b] = sample(map, t);
  const cold = 1 - (t < 0 ? 0 : t > 1 ? 1 : t);
  return [
    r + (1 - r) * LEGACY_BLACK_POINT[0] * cold,
    g + (1 - g) * LEGACY_BLACK_POINT[1] * cold,
    b + (1 - b) * LEGACY_BLACK_POINT[2] * cold,
  ];
}

describe('markColor under the dark palette', () => {
  it('reproduces the pre-theme expression bit for bit, on every colormap', () => {
    for (const map of COLORMAP_IDS) {
      for (const t of SAMPLE_POSITIONS) {
        expect(markColor(map, t, DARK.mark)).toEqual(legacyMarkColor(map, t));
      }
    }
  });

  it('clamps out-of-range t the way it always did', () => {
    for (const t of [-0.5, 1.5]) {
      expect(markColor('inferno', t, DARK.mark)).toEqual(legacyMarkColor('inferno', t));
    }
  });

  it('lifts the cold end and leaves the hot end alone', () => {
    const cold = markColor('inferno', 0, DARK.mark);
    const hot = markColor('inferno', 1, DARK.mark);
    for (let channel = 0; channel < 3; channel++) {
      expect(cold[channel]).toBeGreaterThan(sample('inferno', 0)[channel]);
      expect(hot[channel]).toBe(sample('inferno', 1)[channel]);
    }
  });
});

describe('markColor under the light palette', () => {
  it('mirrors the rule: the hot end is pulled down, the cold end is untouched', () => {
    const cold = markColor('inferno', 0, LIGHT.mark);
    const hot = markColor('inferno', 1, LIGHT.mark);
    for (let channel = 0; channel < 3; channel++) {
      expect(cold[channel]).toBe(sample('inferno', 0)[channel]);
      expect(hot[channel]).toBeLessThan(sample('inferno', 1)[channel]);
    }
  });

  it('applies the tabled per-channel strength at the hot end', () => {
    const [r, g, b] = sample('inferno', 1);
    expect(markColor('inferno', 1, LIGHT.mark)).toEqual([
      r + (0 - r) * 0.32 * 1,
      g + (0 - g) * 0.32 * 1,
      b + (0 - b) * 0.38 * 1,
    ]);
  });

  it('fades the pull out linearly toward the cold end', () => {
    const [, , b] = sample('inferno', 0.25);
    expect(markColor('inferno', 0.25, LIGHT.mark)[2]).toBeCloseTo(b + (0 - b) * 0.38 * 0.25, 12);
  });

  it('only ever darkens, on every colormap, where dark theme only ever lightens', () => {
    for (const map of COLORMAP_IDS) {
      for (const t of SAMPLE_POSITIONS) {
        const raw = sample(map, t);
        const light = markColor(map, t, LIGHT.mark);
        const dark = markColor(map, t, DARK.mark);
        for (let channel = 0; channel < 3; channel++) {
          expect(light[channel]).toBeLessThanOrEqual(raw[channel]);
          expect(dark[channel]).toBeGreaterThanOrEqual(raw[channel]);
        }
      }
    }
  });
});

describe('markCssColor', () => {
  it('rounds the blended channels of whichever theme it is given', () => {
    const [r, g, b] = markColor('inferno', 0, DARK.mark);
    expect(markCssColor('inferno', 0, DARK.mark)).toBe(
      `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`,
    );
    expect(markCssColor('inferno', 1, LIGHT.mark)).not.toBe(markCssColor('inferno', 1, DARK.mark));
  });
});

describe('plotPalette', () => {
  const KEYS: readonly (keyof PlotPalette)[] = [
    'axis',
    'grid',
    'accent',
    'threshold',
    'reference',
    'contour',
    'convection',
    'radiation',
    'barEdge',
    'panel',
    'panelRgb',
    'mark',
    'series',
  ];

  it('defines every key in both themes, so a half-converted palette cannot ship', () => {
    for (const palette of [DARK, LIGHT]) {
      expect(Object.keys(palette).sort()).toEqual([...KEYS].sort());
      for (const key of KEYS) {
        expect(palette[key], key).toBeDefined();
      }
    }
  });

  it('gives the two themes different values for every key', () => {
    for (const key of KEYS) {
      expect(JSON.stringify(DARK[key]), key).not.toBe(JSON.stringify(LIGHT[key]));
    }
  });

  it('returns one shared object per theme, so it is safe as a memo dependency', () => {
    expect(plotPalette('dark')).toBe(DARK);
    expect(plotPalette('light')).toBe(LIGHT);
  });

  it('keeps panel and panelRgb in step', () => {
    expect(DARK.panelRgb).toEqual(parseHexColor(DARK.panel));
    expect(LIGHT.panelRgb).toEqual(parseHexColor(LIGHT.panel));
  });

  it('blends marks toward the pole its own panel is furthest from', () => {
    expect(DARK.mark).toEqual({ target: 1, strength: [0.22, 0.22, 0.3], end: 'cold' });
    expect(LIGHT.mark).toEqual({ target: 0, strength: [0.32, 0.32, 0.38], end: 'hot' });
  });

  it('pairs the two series ramps index for index, so a part keeps its identity', () => {
    expect(LIGHT.series).toHaveLength(DARK.series.length);
    expect(DARK.series.length).toBeGreaterThan(0);
  });
});

describe('seriesColor', () => {
  it('wraps rather than running out of hues', () => {
    const { series } = DARK;
    expect(seriesColor(series.length, series)).toBe(series[0]);
    expect(seriesColor(-1, series)).toBe(series[series.length - 1]);
  });

  it('reads from the ramp it is handed, so the two themes differ at every index', () => {
    for (let index = 0; index < DARK.series.length; index++) {
      expect(seriesColor(index, DARK.series)).not.toBe(seriesColor(index, LIGHT.series));
    }
  });
});

/**
 * The floor covers the colours a reader has to *resolve*, and the exclusions are by
 * name at the floor's own value rather than by lowering it.
 *
 * `axis` is structural chrome: it measures 1.61 on dark and 1.85 on light, and that is
 * correct — a hairline that competes with the data for attention is a worse plot.
 * `grid`, `contour` and `barEdge` are chrome too, and translucent besides, so a ratio
 * taken on their nominal colour is not the one the eye sees.
 */
const ENCODING_KEYS = [
  'accent',
  'threshold',
  'reference',
  'convection',
  'radiation',
] as const satisfies readonly (keyof PlotPalette)[];

const CONTRAST_FLOOR = 3;

describe.each([
  ['dark', DARK],
  ['light', LIGHT],
] as const)('%s palette contrast against its own panel', (_theme, palette) => {
  const panel = parseHexColor(palette.panel);

  it.each(ENCODING_KEYS)(`%s clears the panel by ${CONTRAST_FLOOR}`, (key) => {
    expect(contrastRatio(parseHexColor(palette[key]), panel)).toBeGreaterThanOrEqual(
      CONTRAST_FLOOR,
    );
  });

  it.each(palette.series)(`series %s clears the panel by ${CONTRAST_FLOOR}`, (color) => {
    expect(contrastRatio(parseHexColor(color), panel)).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
  });
});
