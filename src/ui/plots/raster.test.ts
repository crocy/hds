import { describe, expect, it } from 'vitest';
import { CELL_CAVITY, CELL_OUTSIDE, CELL_SHELL } from '@/core/types';
import { normalize, sample } from '@/viewer/colormap';
import { createRgbaBuffer, fillRgbaBuffer, rasteriseField, rasteriseScatter } from './raster';
import { makeScale, type LinearScale } from './scales';
import { markColor, plotPalette } from './theme';

/** The rasterisers are theme-agnostic; the dark palette is what the plots ship with by default. */
const DARK = plotPalette('dark');

function pixel(buffer: ReturnType<typeof createRgbaBuffer>, x: number, y: number) {
  const offset = (y * buffer.width + x) * 4;
  return [
    buffer.data[offset],
    buffer.data[offset + 1],
    buffer.data[offset + 2],
    buffer.data[offset + 3],
  ];
}

function expectedColor(map: 'inferno', value: number, min: number, max: number) {
  return sample(map, normalize(value, min, max)).map((c) => Math.round(c * 255));
}

/** Points carry the colormap blended clear of the panel, so no end of it lands on the ground. */
function expectedPointColor(map: 'inferno', value: number, min: number, max: number) {
  return markColor(map, normalize(value, min, max), DARK.mark).map((c) => Math.round(c * 255));
}

describe('rasteriseField', () => {
  const range = { map: 'inferno' as const, min: 300, max: 400 };

  it('leaves cells outside the model fully transparent, not black', () => {
    const field = {
      width: 2,
      height: 1,
      values: new Float32Array([350, 350]),
      mask: new Uint8Array([CELL_SHELL, CELL_OUTSIDE]),
    };
    const buffer = rasteriseField(field, range);
    expect(pixel(buffer, 0, 0)[3]).toBe(255);
    expect(pixel(buffer, 1, 0)).toEqual([0, 0, 0, 0]);
  });

  it('leaves NaN cells transparent even when the mask says they are inside', () => {
    const field = {
      width: 2,
      height: 1,
      values: new Float32Array([NaN, 350]),
      mask: new Uint8Array([CELL_CAVITY, CELL_SHELL]),
    };
    const buffer = rasteriseField(field, range);
    expect(pixel(buffer, 0, 0)[3]).toBe(0);
    expect(pixel(buffer, 1, 0)[3]).toBe(255);
  });

  it('flips vertically: grid row 0 is the bottom of the plot', () => {
    const field = {
      width: 1,
      height: 2,
      values: new Float32Array([300, 400]),
      mask: new Uint8Array([CELL_SHELL, CELL_SHELL]),
    };
    const buffer = rasteriseField(field, range);
    // Row 0 of the buffer is the top, which must hold the v = max sample (400 K).
    expect(pixel(buffer, 0, 0).slice(0, 3)).toEqual(expectedColor('inferno', 400, 300, 400));
    expect(pixel(buffer, 0, 1).slice(0, 3)).toEqual(expectedColor('inferno', 300, 300, 400));
  });

  it('colours through the shared colormap', () => {
    const field = { width: 1, height: 1, values: new Float32Array([350]) };
    const buffer = rasteriseField(field, range);
    expect(pixel(buffer, 0, 0).slice(0, 3)).toEqual(expectedColor('inferno', 350, 300, 400));
  });

  it('works without a mask', () => {
    const field = { width: 2, height: 1, values: new Float32Array([300, NaN]) };
    const buffer = rasteriseField(field, range);
    expect(pixel(buffer, 0, 0)[3]).toBe(255);
    expect(pixel(buffer, 1, 0)[3]).toBe(0);
  });

  it('reuses a buffer of matching size, clearing it first', () => {
    const reusable = createRgbaBuffer(1, 1);
    reusable.data.set([9, 9, 9, 9]);
    const out = rasteriseField(
      { width: 1, height: 1, values: new Float32Array([NaN]) },
      range,
      reusable,
    );
    expect(out).toBe(reusable);
    expect(pixel(out, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('survives an empty grid', () => {
    const buffer = rasteriseField({ width: 0, height: 0, values: new Float32Array(0) }, range);
    expect(buffer.width).toBe(1);
    expect(buffer.height).toBe(1);
  });
});

describe('fillRgbaBuffer', () => {
  it('paints every pixel opaque, so a scatter blends onto a known ground', () => {
    const buffer = createRgbaBuffer(2, 2);
    fillRgbaBuffer(buffer, [0, 0.5, 1]);
    for (let x = 0; x < 2; x++) {
      for (let y = 0; y < 2; y++) {
        expect(pixel(buffer, x, y)).toEqual([0, 128, 255, 255]);
      }
    }
  });
});

describe('rasteriseScatter', () => {
  const style = {
    map: 'inferno' as const,
    min: 300,
    max: 400,
    alpha: 1,
    radius: 0,
    mark: DARK.mark,
  };
  const identity: LinearScale = makeScale({ min: 0, max: 10 }, 0, 10);

  it('places a point at the pixel its scales map to, in the colormap colour', () => {
    const buffer = createRgbaBuffer(11, 11);
    const drawn = rasteriseScatter(
      buffer,
      [3],
      [4],
      [400],
      identity,
      makeScale({ min: 0, max: 10 }, 0, 10),
      style,
    );
    expect(drawn).toBe(1);
    expect(pixel(buffer, 3, 4).slice(0, 3)).toEqual(expectedPointColor('inferno', 400, 300, 400));
    expect(pixel(buffer, 3, 4)[3]).toBe(255);
    expect(pixel(buffer, 0, 0)[3]).toBe(0);
  });

  it('skips nodes the conduction graph never reached', () => {
    const buffer = createRgbaBuffer(11, 11);
    const drawn = rasteriseScatter(
      buffer,
      [Infinity, NaN, 2],
      [1, 1, 1],
      [350, 350, 350],
      identity,
      identity,
      style,
    );
    expect(drawn).toBe(1);
  });

  it('skips points outside the buffer instead of wrapping around it', () => {
    const buffer = createRgbaBuffer(4, 4);
    const drawn = rasteriseScatter(
      buffer,
      [-5, 40, 1],
      [1, 1, 1],
      [350, 350, 350],
      identity,
      identity,
      style,
    );
    expect(drawn).toBe(1);
    // A wrapped write would have landed somewhere on row 1; only x = 1 may be set.
    for (let x = 0; x < 4; x++) {
      expect(pixel(buffer, x, 1)[3]).toBe(x === 1 ? 255 : 0);
    }
  });

  it('accumulates overlapping points toward full opacity', () => {
    const buffer = createRgbaBuffer(4, 4);
    rasteriseScatter(buffer, [1], [1], [350], identity, identity, { ...style, alpha: 0.5 });
    expect(pixel(buffer, 1, 1)[3]).toBeCloseTo(128, -1);
    rasteriseScatter(buffer, [1], [1], [350], identity, identity, { ...style, alpha: 0.5 });
    expect(pixel(buffer, 1, 1)[3]).toBeCloseTo(191, -1);
  });

  it('preserves the colour of a single translucent point over an empty buffer', () => {
    const buffer = createRgbaBuffer(4, 4);
    rasteriseScatter(buffer, [1], [1], [400], identity, identity, { ...style, alpha: 0.4 });
    // Straight alpha: the colour must be the point colour, only less opaque.
    expect(pixel(buffer, 1, 1).slice(0, 3)).toEqual(expectedPointColor('inferno', 400, 300, 400));
  });

  it('draws a square stamp for a non-zero radius, clipped at the edge', () => {
    const buffer = createRgbaBuffer(5, 5);
    rasteriseScatter(buffer, [0], [0], [350], identity, identity, { ...style, radius: 1 });
    expect(pixel(buffer, 0, 0)[3]).toBe(255);
    expect(pixel(buffer, 1, 1)[3]).toBe(255);
    expect(pixel(buffer, 2, 0)[3]).toBe(0);
  });

  it('keeps the coldest point clear of the panel it is drawn on', () => {
    const buffer = createRgbaBuffer(4, 4);
    fillRgbaBuffer(buffer, DARK.panelRgb);
    rasteriseScatter(buffer, [1], [1], [300], identity, identity, style);
    const point = pixel(buffer, 1, 1);
    const panel = pixel(buffer, 0, 0);
    // The raw colormap would put the cold end within a whisker of the panel.
    const raw = expectedColor('inferno', 300, 300, 400);
    expect(Math.max(...raw)).toBeLessThan(Math.max(...panel));
    for (let channel = 0; channel < 3; channel++) {
      expect(point[channel]).toBeGreaterThan(panel[channel] + 15);
    }
  });

  it('takes its lift from the style, so the two themes rasterise differently', () => {
    const light = plotPalette('light');
    const onDark = createRgbaBuffer(4, 4);
    fillRgbaBuffer(onDark, DARK.panelRgb);
    rasteriseScatter(onDark, [1], [1], [400], identity, identity, style);
    const onLight = createRgbaBuffer(4, 4);
    fillRgbaBuffer(onLight, light.panelRgb);
    rasteriseScatter(onLight, [1], [1], [400], identity, identity, {
      ...style,
      mark: light.mark,
    });
    expect([...onLight.data]).not.toEqual([...onDark.data]);
  });

  it('draws nothing at zero opacity', () => {
    const buffer = createRgbaBuffer(4, 4);
    expect(
      rasteriseScatter(buffer, [1], [1], [350], identity, identity, { ...style, alpha: 0 }),
    ).toBe(0);
  });

  it('stops at the shortest of the three arrays', () => {
    const buffer = createRgbaBuffer(8, 8);
    expect(rasteriseScatter(buffer, [1, 2, 3], [1, 2], [350], identity, identity, style)).toBe(1);
  });
});
