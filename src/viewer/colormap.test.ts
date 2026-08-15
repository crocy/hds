import { describe, expect, it } from 'vitest';
import type { ColorScale, ColormapId } from '@/core/types';
import {
  COLORMAP_IDS,
  cssColor,
  gradientCss,
  isDiverging,
  normalize,
  resolveScaleRange,
  sample,
  srgbToLinear,
  symmetricRange,
  writeRgbaBytes,
  writeVertexColors,
} from './colormap';

const maps = COLORMAP_IDS;

function expectRgb(actual: number[], expected: number[], precision = 4) {
  expect(actual).toHaveLength(3);
  for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], precision);
}

describe('sample', () => {
  it('returns the first table entry at t = 0 and the last at t = 1', () => {
    expectRgb(sample('inferno', 0), [0.0015, 0.0005, 0.0139]);
    expectRgb(sample('inferno', 1), [0.9884, 0.9983, 0.6449]);
    expectRgb(sample('viridis', 0), [0.267, 0.0049, 0.3294]);
    expectRgb(sample('viridis', 1), [0.9932, 0.9062, 0.1439]);
    expectRgb(sample('coolwarm', 0), [0.2298, 0.2987, 0.7537]);
    expectRgb(sample('coolwarm', 1), [0.7057, 0.0156, 0.1502]);
  });

  it('hits the table midpoint exactly for odd-length tables', () => {
    expectRgb(sample('inferno', 0.5), [0.7355, 0.2154, 0.3306]);
    expectRgb(sample('coolwarm', 0.5), [0.8654, 0.8654, 0.8654]);
  });

  it('interpolates linearly between control points', () => {
    // Halfway between the 0.0 and 0.1 stops of inferno.
    expectRgb(sample('inferno', 0.05), [
      (0.0015 + 0.0872) / 2,
      (0.0005 + 0.0448) / 2,
      (0.0139 + 0.2226) / 2,
    ]);
  });

  it('clamps outside [0,1] and treats NaN as 0', () => {
    for (const map of maps) {
      expectRgb(sample(map, -3), sample(map, 0));
      expectRgb(sample(map, 4), sample(map, 1));
      expectRgb(sample(map, Number.NaN), sample(map, 0));
      expectRgb(sample(map, Number.POSITIVE_INFINITY), sample(map, 0));
    }
  });

  it('stays inside the unit cube everywhere', () => {
    for (const map of maps) {
      for (let i = 0; i <= 200; i++) {
        for (const channel of sample(map, i / 200)) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('coolwarm is diverging', () => {
  it('is flagged as diverging and no other map is', () => {
    expect(isDiverging('coolwarm')).toBe(true);
    expect(isDiverging('inferno')).toBe(false);
    expect(isDiverging('viridis')).toBe(false);
    expect(isDiverging('turbo')).toBe(false);
  });

  it('is neutral (r=g=b) at the centre and cool below / warm above it', () => {
    const [r, g, b] = sample('coolwarm', 0.5);
    expect(r).toBeCloseTo(g, 3);
    expect(g).toBeCloseTo(b, 3);

    const cool = sample('coolwarm', 0.15);
    expect(cool[2]).toBeGreaterThan(cool[0]);
    const warm = sample('coolwarm', 0.85);
    expect(warm[0]).toBeGreaterThan(warm[2]);
  });

  it('is roughly symmetric in lightness about the centre', () => {
    const lightness = (t: number) => {
      const [r, g, b] = sample('coolwarm', t);
      return 0.299 * r + 0.587 * g + 0.114 * b;
    };
    for (const d of [0.1, 0.2, 0.3, 0.4]) {
      expect(lightness(0.5 - d)).toBeCloseTo(lightness(0.5 + d), 1);
    }
  });
});

describe('normalize', () => {
  it('maps the range onto [0,1] and clamps outside it', () => {
    expect(normalize(300, 300, 400)).toBe(0);
    expect(normalize(350, 300, 400)).toBeCloseTo(0.5, 12);
    expect(normalize(400, 300, 400)).toBe(1);
    expect(normalize(-10, 300, 400)).toBe(0);
    expect(normalize(1e6, 300, 400)).toBe(1);
  });

  it('reads a degenerate range as the midpoint', () => {
    expect(normalize(300, 300, 300)).toBe(0.5);
    expect(normalize(999, 300, 300)).toBe(0.5);
  });
});

describe('writeVertexColors', () => {
  it('writes one rgb triple per value matching sample()', () => {
    const values = new Float32Array([300, 325, 350]);
    const out = new Float32Array(9);
    writeVertexColors(values, 300, 350, 'turbo', out);
    expectRgb([out[0], out[1], out[2]], sample('turbo', 0));
    expectRgb([out[3], out[4], out[5]], sample('turbo', 0.5));
    expectRgb([out[6], out[7], out[8]], sample('turbo', 1));
  });

  it('clamps values outside the scale rather than wrapping', () => {
    const out = new Float32Array(6);
    writeVertexColors(new Float32Array([-500, 5000]), 300, 350, 'inferno', out);
    expectRgb([out[0], out[1], out[2]], sample('inferno', 0));
    expectRgb([out[3], out[4], out[5]], sample('inferno', 1));
  });

  it('falls back to the midpoint colour for a degenerate scale instead of NaN', () => {
    const out = new Float32Array(3);
    writeVertexColors(new Float32Array([293.15]), 293.15, 293.15, 'coolwarm', out);
    expectRgb([out[0], out[1], out[2]], sample('coolwarm', 0.5));
  });

  it('linearises when asked', () => {
    const plain = new Float32Array(3);
    const linear = new Float32Array(3);
    writeVertexColors(new Float32Array([320]), 300, 350, 'viridis', plain);
    writeVertexColors(new Float32Array([320]), 300, 350, 'viridis', linear, { linear: true });
    for (let i = 0; i < 3; i++) expect(linear[i]).toBeCloseTo(srgbToLinear(plain[i]), 6);
  });

  it('leaves trailing slots untouched when out is longer than needed', () => {
    const out = new Float32Array(6).fill(-1);
    writeVertexColors(new Float32Array([300]), 300, 350, 'inferno', out);
    expect(out[3]).toBe(-1);
  });
});

describe('writeRgbaBytes', () => {
  it('emits opaque bytes for finite values and transparent for NaN', () => {
    const out = new Uint8Array(8);
    writeRgbaBytes(new Float32Array([350, Number.NaN]), 300, 350, 'inferno', out);
    expect(out[3]).toBe(255);
    const [r, g, b] = sample('inferno', 1);
    expect(out[0]).toBe(Math.round(r * 255));
    expect(out[1]).toBe(Math.round(g * 255));
    expect(out[2]).toBe(Math.round(b * 255));
    expect(out.slice(4)).toEqual(new Uint8Array([0, 0, 0, 0]));
  });
});

describe('gradientCss', () => {
  it('starts at 0% with the low end and ends at 100% with the high end', () => {
    const css = gradientCss('inferno', 11);
    expect(css.startsWith('linear-gradient(90deg, ')).toBe(true);
    expect(css).toContain(`${cssColor('inferno', 0)} 0.00%`);
    expect(css).toContain(`${cssColor('inferno', 1)} 100.00%`);
    expect(css.split(', rgb').length - 1).toBe(11);
  });

  it('honours the direction argument', () => {
    expect(gradientCss('viridis', 3, 'to top')).toContain('linear-gradient(to top, ');
  });
});

describe('symmetricRange', () => {
  it('expands the shorter side so the centre lands at t = 0.5', () => {
    const [lo, hi] = symmetricRange(280, 400, 293.15);
    expect(lo).toBeCloseTo(293.15 - 106.85, 9);
    expect(hi).toBeCloseTo(293.15 + 106.85, 9);
    expect(normalize(293.15, lo, hi)).toBeCloseTo(0.5, 12);
  });
});

describe('resolveScaleRange', () => {
  const scale = (over: Partial<ColorScale>): ColorScale => ({
    mode: 'auto',
    min: 0,
    max: 0,
    map: 'inferno' as ColormapId,
    ...over,
  });
  const ambient = 293.15;

  it('auto uses the data range', () => {
    const temps = new Float32Array([300, 310, 473]);
    expect(resolveScaleRange(scale({ mode: 'auto' }), temps, ambient)).toEqual([300, 473]);
  });

  it('ambientToMax pins the low end to ambient', () => {
    const temps = new Float32Array([300, 473]);
    expect(resolveScaleRange(scale({ mode: 'ambientToMax' }), temps, ambient)).toEqual([
      ambient,
      473,
    ]);
  });

  it('manual is honoured verbatim, even for a diverging map', () => {
    const s = scale({ mode: 'manual', min: 250, max: 500, map: 'coolwarm' });
    expect(resolveScaleRange(s, new Float32Array([300]), ambient)).toEqual([250, 500]);
  });

  it('centres a diverging auto scale on ambient', () => {
    const temps = new Float32Array([ambient - 5, ambient + 60]);
    const [lo, hi] = resolveScaleRange(scale({ mode: 'auto', map: 'coolwarm' }), temps, ambient);
    expect(lo).toBeCloseTo(ambient - 60, 4);
    expect(hi).toBeCloseTo(ambient + 60, 4);
    expect(normalize(ambient, lo, hi)).toBeCloseTo(0.5, 5);
  });

  it('never returns a degenerate range', () => {
    const uniform = new Float32Array([ambient, ambient, ambient]);
    const [lo, hi] = resolveScaleRange(scale({ mode: 'auto' }), uniform, ambient);
    expect(hi).toBeGreaterThan(lo);
    const [lo2, hi2] = resolveScaleRange(scale({ mode: 'manual', min: 5, max: 5 }), null, ambient);
    expect(hi2).toBeGreaterThan(lo2);
  });

  it('falls back to a band around ambient when there is no data', () => {
    const [lo, hi] = resolveScaleRange(scale({ mode: 'auto' }), null, ambient);
    expect(lo).toBeLessThan(ambient);
    expect(hi).toBeGreaterThan(ambient);
  });

  it('ignores non-finite samples in the data range', () => {
    const temps = new Float32Array([Number.NaN, 300, 400, Number.POSITIVE_INFINITY]);
    expect(resolveScaleRange(scale({ mode: 'auto' }), temps, ambient)).toEqual([300, 400]);
  });
});
