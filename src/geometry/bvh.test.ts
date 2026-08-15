import { describe, expect, it } from 'vitest';

import { boxMesh, mergeMeshes, modelFromMesh, stripMesh } from '../core/testModels';
import type { ThermalModel } from '../core/types';
import {
  buildBvh,
  closestPointInto,
  closestPointOnMesh,
  closestPointOnTriangle,
  createClosestPointResult,
  raycastNearest,
} from './bvh';

/** One triangle in the z = 0 plane: (0,0,0), (1,0,0), (0,1,0). */
const UNIT_TRIANGLE = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

function closestPoint(x: number, y: number, z: number): [number, number, number] {
  const out = new Float64Array(3);
  closestPointOnTriangle(UNIT_TRIANGLE, 0, x, y, z, out);
  return [out[0], out[1], out[2]];
}

function distanceTo(x: number, y: number, z: number): number {
  const [px, py, pz] = closestPoint(x, y, z);
  return Math.hypot(px - x, py - y, pz - z);
}

describe('closestPointOnTriangle', () => {
  it('projects a point above the interior onto the plane', () => {
    expect(closestPoint(0.25, 0.25, 3)).toEqual([0.25, 0.25, 0]);
  });

  it('clamps to a vertex when the projection falls outside a corner', () => {
    // Plane distance would say 1; the answer is the distance to the corner.
    expect(closestPoint(-3, -4, 1)).toEqual([0, 0, 0]);
    expect(distanceTo(-3, -4, 1)).toBeCloseTo(Math.hypot(3, 4, 1), 12);
    expect(closestPoint(5, -1, 0)).toEqual([1, 0, 0]);
    expect(closestPoint(-1, 5, 0)).toEqual([0, 1, 0]);
  });

  it('clamps to an edge when the projection falls outside one side', () => {
    expect(closestPoint(0.5, -2, 0)).toEqual([0.5, 0, 0]);
    expect(closestPoint(-2, 0.5, 0)).toEqual([0, 0.5, 0]);
    // Beyond the hypotenuse, which no axis test would catch.
    const [x, y, z] = closestPoint(1, 1, 0);
    expect(x).toBeCloseTo(0.5, 12);
    expect(y).toBeCloseTo(0.5, 12);
    expect(z).toBe(0);
  });

  it('falls back to a vertex on a degenerate triangle', () => {
    const sliver = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const out = new Float64Array(3);
    closestPointOnTriangle(sliver, 0, 1, 1, 1, out);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });
});

function bruteForceNearest(
  model: ThermalModel,
  x: number,
  y: number,
  z: number,
): { triangle: number; distance: number } {
  const out = new Float64Array(3);
  const verts = new Float32Array(9);
  let best = { triangle: -1, distance: Infinity };
  for (let t = 0; t < model.triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const n = model.tris[t * 3 + c] * 3;
      verts[c * 3] = model.nodes[n];
      verts[c * 3 + 1] = model.nodes[n + 1];
      verts[c * 3 + 2] = model.nodes[n + 2];
    }
    closestPointOnTriangle(verts, 0, x, y, z, out);
    const distance = Math.hypot(out[0] - x, out[1] - y, out[2] - z);
    if (distance < best.distance) best = { triangle: t, distance };
  }
  return best;
}

describe('closest point queries', () => {
  const model = modelFromMesh(
    mergeMeshes(
      boxMesh([0.1, 0.1, 0.1], [0, 0, 0], 0),
      stripMesh(0.05, 0.05, 5, 5, 1, 0, [0.3, 0.2, 0.15]),
    ),
    [{ name: 'box' }, { name: 'plate' }],
  );
  const bvh = buildBvh(model, { maxLeafSize: 2 });

  it('agrees with a brute-force scan over the whole mesh', () => {
    const out = createClosestPointResult();
    let checked = 0;
    for (let i = 0; i < 200; i++) {
      // Deterministic pseudo-random points spread over and around the model.
      const x = ((i * 37) % 41) / 41 - 0.15 + 0.4 * (((i * 13) % 7) / 7);
      const y = ((i * 53) % 43) / 43 - 0.1;
      const z = ((i * 29) % 47) / 47 - 0.05;
      const expected = bruteForceNearest(model, x, y, z);
      expect(closestPointInto(bvh, x, y, z, out)).toBe(true);
      expect(out.distance).toBeCloseTo(expected.distance, 6);
      const found = Math.hypot(out.x - x, out.y - y, out.z - z);
      expect(found).toBeCloseTo(expected.distance, 6);
      checked++;
    }
    expect(checked).toBe(200);
  });

  it('reports nothing outside maxDistance', () => {
    const out = createClosestPointResult();
    expect(closestPointInto(bvh, 10, 10, 10, out, { maxDistance: 0.001 })).toBe(false);
    expect(out.triangle).toBe(-1);
    expect(out.distance).toBe(Infinity);
    // Triangle vertices are stored as Float32, so the last couple of nanometres are noise.
    expect(
      closestPointOnMesh(bvh, 0.05, 0.05, 0.1001, { maxDistance: 0.001 })?.distance,
    ).toBeCloseTo(0.0001, 7);
  });

  it('skips triangles the caller rejects', () => {
    // Directly under the plate, but only the far-away box is acceptable.
    const point = { x: 0.32, y: 0.22, z: 0.1502 };
    const nearest = closestPointOnMesh(bvh, point.x, point.y, point.z);
    expect(model.triPart[nearest!.triangle]).toBe(1);

    const onBox = closestPointOnMesh(bvh, point.x, point.y, point.z, {
      accept: (triangle) => model.triPart[triangle] === 0,
    });
    expect(model.triPart[onBox!.triangle]).toBe(0);
    expect(onBox!.distance).toBeGreaterThan(nearest!.distance);

    const skipped = closestPointOnMesh(bvh, point.x, point.y, point.z, {
      skipTriangle: nearest!.triangle,
    });
    expect(skipped!.triangle).not.toBe(nearest!.triangle);
  });

  it('returns nothing for an empty mesh', () => {
    const empty = buildBvh(modelFromMesh({ positions: [], indices: [], partOf: [], faceOf: [] }));
    expect(closestPointOnMesh(empty, 0, 0, 0)).toBeNull();
    expect(raycastNearest(empty, [0, 0, 0], [0, 0, 1])).toBeNull();
  });
});
