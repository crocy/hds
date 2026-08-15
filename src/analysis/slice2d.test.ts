import { describe, expect, it } from 'vitest';
import { boxMesh, modelFromMesh } from '../core/testModels';
import { CELL_AMBIENT, CELL_CAVITY, CELL_OUTSIDE, CELL_SHELL, type Vec3 } from '../core/types';
import { planeBasis, sectionModel } from '../geometry/section';
import { solveSliceField, type SlicePolyline } from './slice2d';

const AMBIENT = 293.15;
const XY_BASIS = planeBasis({ normal: [0, 0, 1], origin: [0, 0, 0] });
const EXTENT = { uMin: 0, uMax: 1, vMin: 0, vMax: 1 };
const WALL_MIN = 0.2;
const WALL_MAX = 0.8;

/** A square wall in z = 0, sampled densely enough that no grid cell is stepped over. */
function squareWall(temperatureAt: (u: number, v: number) => number, cavityId = 1): SlicePolyline {
  const corners: Array<[number, number]> = [
    [WALL_MIN, WALL_MIN],
    [WALL_MAX, WALL_MIN],
    [WALL_MAX, WALL_MAX],
    [WALL_MIN, WALL_MAX],
    [WALL_MIN, WALL_MIN],
  ];
  const perEdge = 40;
  const u: number[] = [];
  const v: number[] = [];
  for (let edge = 0; edge + 1 < corners.length; edge++) {
    for (let s = 0; s < perEdge; s++) {
      const f = s / perEdge;
      u.push(corners[edge][0] + f * (corners[edge + 1][0] - corners[edge][0]));
      v.push(corners[edge][1] + f * (corners[edge + 1][1] - corners[edge][1]));
    }
  }
  u.push(corners[0][0]);
  v.push(corners[0][1]);

  const count = u.length;
  const points = new Float32Array(count * 3);
  const temperature = new Float32Array(count);
  const arcLength = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    points[k * 3] = u[k];
    points[k * 3 + 1] = v[k];
    temperature[k] = temperatureAt(u[k], v[k]);
    if (k > 0) arcLength[k] = arcLength[k - 1] + Math.hypot(u[k] - u[k - 1], v[k] - v[k - 1]);
  }
  return { partId: 'part-0', points, temperature, arcLength, closed: true, cavityId };
}

function cellCentre(index: number, count: number, min: number, max: number): number {
  return min + ((index + 0.5) * (max - min)) / count;
}

describe('solveSliceField', () => {
  it('settles a uniformly hot cavity at the wall temperature', () => {
    const field = solveSliceField([squareWall(() => 400)], XY_BASIS, {
      extent: EXTENT,
      ambient: AMBIENT,
      fillK: 0.026,
      width: 64,
      height: 64,
    });

    let cavityCells = 0;
    let ambientCells = 0;
    let shellCells = 0;
    for (let cell = 0; cell < field.values.length; cell++) {
      switch (field.mask[cell]) {
        case CELL_CAVITY:
          cavityCells++;
          expect(field.values[cell]).toBeCloseTo(400, 2);
          break;
        case CELL_AMBIENT:
          ambientCells++;
          expect(field.values[cell]).toBeCloseTo(AMBIENT, 4);
          break;
        case CELL_SHELL:
          shellCells++;
          expect(field.values[cell]).toBeCloseTo(400, 6);
          break;
        default:
          throw new Error(`unexpected mask ${field.mask[cell]} at ${cell}`);
      }
    }
    // The wall spans 60 % of a 64² grid, so the enclosed area is ~0.36 × 4096.
    expect(cavityCells).toBeGreaterThan(1200);
    expect(shellCells).toBeGreaterThan(140);
    expect(ambientCells).toBeGreaterThan(2000);
  });

  it('gives a monotonic gradient between two walls at different temperatures', () => {
    const ramp = (u: number) => 300 + (100 * (u - WALL_MIN)) / (WALL_MAX - WALL_MIN);
    const field = solveSliceField([squareWall((u) => ramp(u))], XY_BASIS, {
      extent: EXTENT,
      ambient: AMBIENT,
      fillK: 0.026,
      width: 64,
      height: 64,
      contours: [350],
    });

    const row = 32;
    let previous = -Infinity;
    let interiorCells = 0;
    let largestError = 0;
    for (let i = 0; i < field.width; i++) {
      const cell = row * field.width + i;
      if (field.mask[cell] !== CELL_CAVITY) continue;
      const value = field.values[cell];
      expect(value).toBeGreaterThan(previous);
      previous = value;
      interiorCells++;
      largestError = Math.max(largestError, Math.abs(value - ramp(cellCentre(i, 64, 0, 1))));
    }
    expect(interiorCells).toBeGreaterThan(30);
    // A linear field is discretely harmonic, so the solve must reproduce it.
    expect(largestError).toBeLessThan(1);

    // Nothing in the setup distinguishes +v from −v.
    for (let j = 0; j < field.height / 2; j++) {
      for (let i = 0; i < field.width; i++) {
        const low = j * field.width + i;
        const high = (field.height - 1 - j) * field.width + i;
        expect(field.mask[low]).toBe(field.mask[high]);
        if (field.mask[low] !== CELL_CAVITY) continue;
        expect(field.values[low]).toBeCloseTo(field.values[high], 2);
      }
    }

    // Inside the cavity the 350 K contour is the vertical line halfway across, to
    // within a cell. It also runs round the outside of the hot wall, where it is
    // the wall-to-ambient step rather than the gradient, so those parts are skipped.
    const [contour] = field.contours;
    expect(contour.level).toBe(350);
    let insideCavity = 0;
    for (let k = 0; k + 3 < contour.segments.length; k += 4) {
      const u = (contour.segments[k] + contour.segments[k + 2]) / 2;
      const v = (contour.segments[k + 1] + contour.segments[k + 3]) / 2;
      const cell = Math.floor(v * field.height) * field.width + Math.floor(u * field.width);
      if (field.mask[cell] !== CELL_CAVITY) continue;
      expect(Math.abs(contour.segments[k] - 0.5)).toBeLessThan(0.02);
      expect(Math.abs(contour.segments[k + 2] - 0.5)).toBeLessThan(0.02);
      insideCavity++;
    }
    expect(insideCavity).toBeGreaterThan(10);
  });

  it('leaves an adiabatic cavity blank rather than inventing a field', () => {
    const field = solveSliceField([squareWall(() => 400)], XY_BASIS, {
      extent: EXTENT,
      ambient: AMBIENT,
      fillK: 0,
      width: 32,
      height: 32,
    });
    let blank = 0;
    for (let cell = 0; cell < field.values.length; cell++) {
      if (field.mask[cell] !== CELL_OUTSIDE) continue;
      blank++;
      expect(field.values[cell]).toBeNaN();
    }
    expect(blank).toBeGreaterThan(200);
    expect(field.contours.every((contour) => Number.isFinite(contour.level))).toBe(true);
  });

  it('treats an open polyline as a wall without an interior', () => {
    const wall = squareWall(() => 400);
    const open: SlicePolyline = { ...wall, closed: false, cavityId: 0 };
    const field = solveSliceField([open], XY_BASIS, {
      extent: EXTENT,
      ambient: AMBIENT,
      fillK: 0.026,
      width: 32,
      height: 32,
    });
    for (let cell = 0; cell < field.values.length; cell++) {
      expect(field.mask[cell] === CELL_AMBIENT || field.mask[cell] === CELL_SHELL).toBe(true);
      expect(Number.isFinite(field.values[cell])).toBe(true);
    }
  });

  it('fills the inside of a sectioned box between its wall temperatures', () => {
    const size: Vec3 = [0.2, 0.1, 0.3];
    const model = modelFromMesh(boxMesh(size));
    const temperature = new Float32Array(model.nodeCount);
    for (let n = 0; n < model.nodeCount; n++) {
      temperature[n] = 300 + (100 * model.nodes[n * 3 + 2]) / size[2];
    }
    const plane = { normal: [0, 1, 0] as Vec3, origin: [0, 0.05, 0] as Vec3 };
    const basis = planeBasis(plane);
    const polylines = sectionModel(model, plane, { temperature });
    expect(polylines).toHaveLength(1);

    const field = solveSliceField(polylines, basis, {
      extent: { uMin: -0.05, uMax: 0.25, vMin: -0.35, vMax: 0.05 },
      ambient: AMBIENT,
      fillK: 0.026,
      width: 64,
      height: 64,
    });

    let interior = 0;
    for (let cell = 0; cell < field.values.length; cell++) {
      if (field.mask[cell] !== CELL_CAVITY) continue;
      interior++;
      expect(field.values[cell]).toBeGreaterThanOrEqual(300);
      expect(field.values[cell]).toBeLessThanOrEqual(400);
    }
    expect(interior).toBeGreaterThan(500);

    // v runs along −z for this plane, so the hot end of the box is at low v.
    const column = 32;
    let hottest = -Infinity;
    let hottestRow = -1;
    for (let j = 0; j < field.height; j++) {
      const cell = j * field.width + column;
      if (field.mask[cell] !== CELL_CAVITY) continue;
      if (field.values[cell] > hottest) {
        hottest = field.values[cell];
        hottestRow = j;
      }
    }
    expect(hottestRow).toBeLessThan(field.height / 2);
  });
});
