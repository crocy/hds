import { describe, expect, it } from 'vitest';
import { contourLevels, marchingSquares, type ScalarGrid } from './marchingSquares';

const WIDTH = 8;
const HEIGHT = 6;

/** Cell centres, matching how `slice2d` rasterises. */
function centreU(i: number): number {
  return (i + 0.5) / WIDTH;
}

function centreV(j: number): number {
  return (j + 0.5) / HEIGHT;
}

/** A field that is exactly its own u (or v) coordinate, so a level is its own position. */
function rampGrid(along: 'u' | 'v'): ScalarGrid {
  const values = new Float32Array(WIDTH * HEIGHT);
  for (let j = 0; j < HEIGHT; j++) {
    for (let i = 0; i < WIDTH; i++) {
      values[j * WIDTH + i] = along === 'u' ? centreU(i) : centreV(j);
    }
  }
  return { width: WIDTH, height: HEIGHT, values, uMin: 0, uMax: 1, vMin: 0, vMax: 1 };
}

describe('marchingSquares', () => {
  it('puts the contour of a ramp at the level itself', () => {
    const segments = marchingSquares(rampGrid('u'), 0.5);
    expect(segments).toHaveLength((HEIGHT - 1) * 4);
    for (let k = 0; k < segments.length; k += 4) {
      expect(segments[k]).toBeCloseTo(0.5, 6);
      expect(segments[k + 2]).toBeCloseTo(0.5, 6);
      // The segment spans one row of cell centres.
      expect(Math.abs(segments[k + 3] - segments[k + 1])).toBeCloseTo(1 / HEIGHT, 6);
    }
  });

  it('turns the contour with the ramp', () => {
    const segments = marchingSquares(rampGrid('v'), 0.5);
    expect(segments).toHaveLength((WIDTH - 1) * 4);
    for (let k = 0; k < segments.length; k += 4) {
      expect(segments[k + 1]).toBeCloseTo(0.5, 6);
      expect(segments[k + 3]).toBeCloseTo(0.5, 6);
    }
  });

  it('follows the level across the ramp', () => {
    for (const level of [0.25, 0.5, 0.75]) {
      const segments = marchingSquares(rampGrid('u'), level);
      expect(segments.length).toBeGreaterThan(0);
      for (let k = 0; k < segments.length; k += 2) {
        expect(segments[k]).toBeCloseTo(level, 6);
      }
    }
  });

  it('produces nothing where cells have no data', () => {
    const grid = rampGrid('u');
    expect(
      marchingSquares({ ...grid, values: new Float32Array(WIDTH * HEIGHT).fill(NaN) }, 0.5),
    ).toHaveLength(0);

    // Blanking one row removes the two cell rows that read from it.
    const punched = Float32Array.from(grid.values);
    for (let i = 0; i < WIDTH; i++) punched[2 * WIDTH + i] = NaN;
    const segments = marchingSquares({ ...grid, values: punched }, 0.5);
    expect(segments).toHaveLength((HEIGHT - 3) * 4);
    for (let k = 0; k < segments.length; k += 4) expect(segments[k]).toBeCloseTo(0.5, 6);
  });

  it('returns nothing for a level outside the field or a degenerate grid', () => {
    expect(marchingSquares(rampGrid('u'), 5)).toHaveLength(0);
    expect(marchingSquares(rampGrid('u'), -5)).toHaveLength(0);
    const single: ScalarGrid = {
      width: 1,
      height: 1,
      values: new Float32Array([1]),
      uMin: 0,
      uMax: 1,
      vMin: 0,
      vMax: 1,
    };
    expect(marchingSquares(single, 0.5)).toHaveLength(0);
  });

  it('cuts both corners of a saddle', () => {
    // Opposite corners high, so the level has to separate two pairs, not one.
    const saddle: ScalarGrid = {
      width: 2,
      height: 2,
      values: new Float32Array([0, 1, 1, 0]),
      uMin: 0,
      uMax: 1,
      vMin: 0,
      vMax: 1,
    };
    expect(marchingSquares(saddle, 0.5)).toHaveLength(8);
  });
});

describe('contourLevels', () => {
  it('keeps one entry per requested level', () => {
    const levels = [0.25, 0.5, 0.75];
    const contours = contourLevels(rampGrid('u'), levels);
    expect(contours.map((contour) => contour.level)).toEqual(levels);
    for (const contour of contours) expect(contour.segments.length).toBeGreaterThan(0);
    expect(contourLevels(rampGrid('u'), [])).toEqual([]);
  });
});
