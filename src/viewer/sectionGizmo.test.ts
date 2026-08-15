import { describe, expect, it } from 'vitest';
import {
  CELL_AMBIENT,
  CELL_CAVITY,
  CELL_OUTSIDE,
  CELL_SHELL,
  type Bounds,
  type SectionField2D,
  type Vec3,
} from '@/core/types';
import { planeBasis } from '@/geometry/section';
import { normalize, sample } from './colormap';
import {
  axisNormal,
  clampOffset,
  closestPointOnAxis,
  offsetRange,
  planeFromOffset,
  planeOffset,
  sectionExtent,
  snapNormalToAxis,
  writeSectionFieldTexture,
} from './sectionGizmo';

const box: Bounds = { min: [-1, -2, -3], max: [1, 2, 3] };

describe('axisNormal', () => {
  it('is the signed principal axis', () => {
    expect(axisNormal('x')).toEqual([1, 0, 0]);
    expect(axisNormal('y', -1)).toEqual([0, -1, 0]);
    expect(axisNormal('z')).toEqual([0, 0, 1]);
  });
});

describe('snapNormalToAxis', () => {
  it('picks the nearest axis and keeps its sign', () => {
    expect(snapNormalToAxis([0.9, 0.3, -0.2])).toEqual([1, 0, 0]);
    expect(snapNormalToAxis([-0.2, -0.9, 0.1])).toEqual([0, -1, 0]);
    expect(snapNormalToAxis([0.1, 0.2, -3])).toEqual([0, 0, -1]);
  });

  it('falls back to +X for a zero normal', () => {
    expect(snapNormalToAxis([0, 0, 0])).toEqual([1, 0, 0]);
  });
});

describe('planeOffset / planeFromOffset', () => {
  it('round-trips through the signed distance along the normal', () => {
    const plane = planeFromOffset([0, 0, 2], 1.5);
    expect(plane.normal).toEqual([0, 0, 1]);
    expect(plane.origin).toEqual([0, 0, 1.5]);
    expect(planeOffset(plane)).toBeCloseTo(1.5, 12);
  });

  it('reads the offset of any point on the plane, not just the foot', () => {
    expect(planeOffset({ normal: [0, 0, 4], origin: [7, -3, 2] })).toBeCloseTo(2, 12);
    const diagonal: Vec3 = [1, 1, 0];
    expect(planeOffset({ normal: diagonal, origin: [1, 1, 9] })).toBeCloseTo(Math.SQRT2, 12);
  });
});

describe('offsetRange / clampOffset', () => {
  it('spans the box along the normal', () => {
    expect(offsetRange(box, [0, 0, 1])).toEqual({ min: -3, max: 3 });
    expect(offsetRange(box, [-1, 0, 0])).toEqual({ min: -1, max: 1 });
    const diagonal = offsetRange(box, [1, 1, 0]);
    expect(diagonal.max).toBeCloseTo(3 / Math.SQRT2, 12);
    expect(diagonal.min).toBeCloseTo(-3 / Math.SQRT2, 12);
  });

  it('keeps the plane from sliding off the model', () => {
    expect(clampOffset(99, box, [0, 0, 1])).toBe(3);
    expect(clampOffset(-99, box, [0, 0, 1])).toBe(-3);
    expect(clampOffset(0.5, box, [0, 0, 1])).toBe(0.5);
  });

  it('re-centres rather than propagating a NaN offset', () => {
    expect(clampOffset(Number.NaN, box, [0, 1, 0])).toBe(0);
  });
});

describe('sectionExtent', () => {
  it('covers the model in the plane basis the slice is solved in', () => {
    const plane = { normal: [1, 0, 0] as Vec3, origin: [0, 0, 0] as Vec3 };
    const extent = sectionExtent(box, plane, 0);
    const basis = planeBasis(plane);
    for (const corner of [
      [-1, -2, -3],
      [1, 2, 3],
      [1, -2, 3],
    ] as Vec3[]) {
      const [u, v] = basis.projectToPlane(corner);
      expect(u).toBeGreaterThanOrEqual(extent.uMin);
      expect(u).toBeLessThanOrEqual(extent.uMax);
      expect(v).toBeGreaterThanOrEqual(extent.vMin);
      expect(v).toBeLessThanOrEqual(extent.vMax);
    }
  });

  it('pads by a fraction of the larger span', () => {
    const plane = { normal: [1, 0, 0] as Vec3, origin: [0, 0, 0] as Vec3 };
    const tight = sectionExtent(box, plane, 0);
    const padded = sectionExtent(box, plane, 0.1);
    const pad = Math.max(tight.uMax - tight.uMin, tight.vMax - tight.vMin) * 0.1;
    expect(padded.uMin).toBeCloseTo(tight.uMin - pad, 12);
    expect(padded.vMax).toBeCloseTo(tight.vMax + pad, 12);
  });
});

describe('closestPointOnAxis', () => {
  it('projects a crossing ray onto the axis', () => {
    expect(closestPointOnAxis([0, 0, 0], [0, 0, 1], [5, 0, 3], [-1, 0, 0])).toBeCloseTo(3, 12);
    expect(closestPointOnAxis([0, 0, 2], [0, 0, 1], [5, 0, 3], [-1, 0, 0])).toBeCloseTo(1, 12);
  });

  it('tracks the drag: moving the ray along the axis moves the answer with it', () => {
    const a = closestPointOnAxis([0, 0, 0], [0, 0, 1], [4, 1, 0], [-1, 0, 0]);
    const b = closestPointOnAxis([0, 0, 0], [0, 0, 1], [4, 1, 0.75], [-1, 0, 0]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect((b as number) - (a as number)).toBeCloseTo(0.75, 12);
  });

  it('refuses to answer when the ray is parallel to the axis', () => {
    expect(closestPointOnAxis([0, 0, 0], [0, 0, 1], [1, 0, -9], [0, 0, 1])).toBeNull();
    expect(closestPointOnAxis([0, 0, 0], [0, 0, 1], [1, 0, -9], [0, 0, -1])).toBeNull();
  });
});

function field(mask: number[], values: number[]): SectionField2D {
  return {
    width: mask.length,
    height: 1,
    uMin: 0,
    uMax: 1,
    vMin: 0,
    vMax: 1,
    values: Float32Array.from(values),
    mask: Uint8Array.from(mask),
    contours: [],
  };
}

describe('writeSectionFieldTexture', () => {
  const masks = [CELL_SHELL, CELL_CAVITY, CELL_AMBIENT, CELL_OUTSIDE];

  it('colours shell and cavity cells and hides outside cells', () => {
    const out = new Uint8Array(4 * 4);
    writeSectionFieldTexture(
      field(masks, [400, 350, 293, Number.NaN]),
      { map: 'inferno', min: 293, max: 400 },
      out,
    );
    expect(out[3]).toBe(255);
    expect(out[7]).toBe(255);
    expect(out[15]).toBe(0);

    const [r, g, b] = sample('inferno', normalize(350, 293, 400));
    expect(out[4]).toBe(Math.round(r * 255));
    expect(out[5]).toBe(Math.round(g * 255));
    expect(out[6]).toBe(Math.round(b * 255));
  });

  it('hides open air by default so the plane does not become a wall', () => {
    const out = new Uint8Array(4 * 4);
    const style = { map: 'inferno' as const, min: 293, max: 400 };
    writeSectionFieldTexture(field(masks, [400, 350, 293, Number.NaN]), style, out);
    expect(out[11]).toBe(0);

    writeSectionFieldTexture(
      field(masks, [400, 350, 293, Number.NaN]),
      { ...style, showAmbient: true },
      out,
    );
    expect(out[11]).toBe(255);
  });

  it('hides a non-finite value whatever its mask says', () => {
    const out = new Uint8Array(4);
    writeSectionFieldTexture(
      field([CELL_SHELL], [Number.NaN]),
      { map: 'viridis', min: 0, max: 1 },
      out,
    );
    expect(out[3]).toBe(0);
  });
});
