import { describe, expect, it } from 'vitest';
import { boxMesh, mergeMeshes, modelFromMesh, stripMesh } from '../core/testModels';
import type { SectionPlane, Vec3 } from '../core/types';
import { planeBasis, sectionModel } from './section';

const BOX: Vec3 = [0.2, 0.1, 0.3];
const BOX_PERIMETER = 2 * (BOX[0] + BOX[1]);

function boxModel() {
  return modelFromMesh(boxMesh(BOX), [{ name: 'box' }]);
}

function plane(normal: Vec3, origin: Vec3): SectionPlane {
  return { normal, origin };
}

/** The unit square in z = 0, with a temperature ramp of 100 K along +x. */
function rampedSquare() {
  const model = modelFromMesh(stripMesh(1, 1, 1, 1));
  const temperature = new Float32Array(model.nodeCount);
  for (let n = 0; n < model.nodeCount; n++) temperature[n] = 300 + 100 * model.nodes[n * 3];
  return { model, temperature };
}

describe('planeBasis', () => {
  it('gives world axes for a principal-axis plane', () => {
    const basis = planeBasis(plane([0, 0, 1], [0, 0, 0.15]));
    expect(Array.from(basis.axisU)).toEqual([1, 0, 0]);
    expect(Array.from(basis.axisV)).toEqual([0, 1, 0]);
    const yz = planeBasis(plane([1, 0, 0], [0, 0, 0]));
    expect(Array.from(yz.axisU)).toEqual([0, 1, 0]);
    expect(Array.from(yz.axisV)).toEqual([0, 0, 1]);
  });

  it('normalises the normal and keeps the axes orthonormal and right-handed', () => {
    const basis = planeBasis(plane([2, -3, 6], [0.1, 0.2, 0.3]));
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(Math.hypot(...basis.normal)).toBeCloseTo(1, 12);
    expect(Math.hypot(...basis.axisU)).toBeCloseTo(1, 12);
    expect(Math.hypot(...basis.axisV)).toBeCloseTo(1, 12);
    expect(dot(basis.axisU, basis.axisV)).toBeCloseTo(0, 12);
    expect(dot(basis.axisU, basis.normal)).toBeCloseTo(0, 12);
    const cross: Vec3 = [
      basis.axisU[1] * basis.axisV[2] - basis.axisU[2] * basis.axisV[1],
      basis.axisU[2] * basis.axisV[0] - basis.axisU[0] * basis.axisV[2],
      basis.axisU[0] * basis.axisV[1] - basis.axisU[1] * basis.axisV[0],
    ];
    expect(dot(cross, basis.normal)).toBeCloseTo(1, 12);
  });

  it('projects onto the plane, dropping the out-of-plane component', () => {
    const basis = planeBasis(plane([0, 0, 1], [1, 2, 3]));
    expect(basis.projectToPlane([1.5, 2.25, 99])).toEqual([0.5, 0.25]);
    const interleaved = new Float32Array([0, 0, 0, 1.5, 2.25, -4]);
    expect(basis.projectToPlane(interleaved, 3)).toEqual([0.5, 0.25]);
  });

  it('rejects a degenerate normal', () => {
    expect(() => planeBasis(plane([0, 0, 0], [0, 0, 0]))).toThrow(/non-zero/);
  });
});

describe('sectionModel', () => {
  it('cuts a box into one closed loop of the right perimeter', () => {
    const cut = sectionModel(boxModel(), plane([0, 0, 1], [0, 0, 0.15]));
    expect(cut).toHaveLength(1);
    const loop = cut[0];
    expect(loop.closed).toBe(true);
    expect(loop.partId).toBe('part-0');
    expect(loop.arcLength[loop.arcLength.length - 1]).toBeCloseTo(BOX_PERIMETER, 6);
    // Eight wall triangles cross, and a closed loop repeats its first point.
    expect(loop.points.length / 3).toBe(9);
    for (let k = 0; k < loop.points.length / 3; k++) {
      expect(loop.points[k * 3 + 2]).toBeCloseTo(0.15, 6);
    }
    expect(loop.points[0]).toBeCloseTo(loop.points[loop.points.length - 3], 9);
    expect(loop.points[1]).toBeCloseTo(loop.points[loop.points.length - 2], 9);
  });

  it('cuts the same perimeter on an oblique-origin plane through the middle', () => {
    const cut = sectionModel(boxModel(), plane([1, 0, 0], [0.1, 0, 0]));
    expect(cut).toHaveLength(1);
    // A cut across the box at constant x is a rectangle of the other two sides.
    expect(cut[0].arcLength[cut[0].arcLength.length - 1]).toBeCloseTo(2 * (BOX[1] + BOX[2]), 6);
  });

  it('returns the face outline when the plane is coincident with a face', () => {
    // The coplanar triangles contribute nothing; the four walls leaving the plane
    // each report the edge they share with that face.
    const cut = sectionModel(boxModel(), plane([0, 0, 1], [0, 0, 0]));
    expect(cut).toHaveLength(1);
    expect(cut[0].closed).toBe(true);
    expect(cut[0].points.length / 3).toBe(5);
    expect(cut[0].arcLength[4]).toBeCloseTo(BOX_PERIMETER, 6);
  });

  it('returns nothing when the plane misses the model', () => {
    expect(sectionModel(boxModel(), plane([0, 0, 1], [0, 0, 5]))).toEqual([]);
    expect(sectionModel(boxModel(), plane([0, 0, 1], [0, 0, -1e-3]))).toEqual([]);
  });

  it('interpolates temperature linearly along the cut edges', () => {
    const { model, temperature } = rampedSquare();
    const cut = sectionModel(model, plane([1, 0, 0], [0.25, 0, 0]), { temperature });
    expect(cut).toHaveLength(1);
    const line = cut[0];
    expect(line.closed).toBe(false);
    expect(line.points.length / 3).toBe(3);
    expect(line.arcLength[line.arcLength.length - 1]).toBeCloseTo(1, 6);
    for (const value of line.temperature) expect(value).toBeCloseTo(325, 4);

    const midway = sectionModel(model, plane([1, 0, 0], [0.5, 0, 0]), { temperature })[0];
    for (const value of midway.temperature) expect(value).toBeCloseTo(350, 4);
  });

  it('reports NaN temperatures when no field is supplied', () => {
    const { model } = rampedSquare();
    const cut = sectionModel(model, plane([1, 0, 0], [0.25, 0, 0]));
    for (const value of cut[0].temperature) expect(value).toBeNaN();
  });

  it('keeps one polyline per part', () => {
    const model = modelFromMesh(
      mergeMeshes(boxMesh(BOX, [0, 0, 0], 0), boxMesh(BOX, [0.5, 0, 0], 1)),
      [{ name: 'left' }, { name: 'right' }],
    );
    const cut = sectionModel(model, plane([0, 0, 1], [0, 0, 0.15]));
    expect(cut).toHaveLength(2);
    expect(cut.map((polyline) => polyline.partId).sort()).toEqual(['part-0', 'part-1']);
    for (const polyline of cut) {
      expect(polyline.closed).toBe(true);
      expect(polyline.arcLength[polyline.arcLength.length - 1]).toBeCloseTo(BOX_PERIMETER, 6);
    }
  });

  it('carries the cavity the wall faces', () => {
    const model = boxModel();
    model.triCavity.fill(3);
    const cut = sectionModel(model, plane([0, 0, 1], [0, 0, 0.15]));
    expect(cut[0].cavityId).toBe(3);
    expect(cut[0].partIndex).toBe(0);
  });

  it('collapses the edge two triangles both report', () => {
    // Two strips of one part meeting at x = 1, cut exactly along that seam: both
    // triangles on the seam see two vertices in the plane and emit the same edge.
    const model = modelFromMesh(
      mergeMeshes(stripMesh(1, 1, 1, 1, 0, 0), stripMesh(1, 1, 1, 1, 0, 1, [1, 0, 0])),
    );
    const cut = sectionModel(model, plane([1, 0, 0], [1, 0, 0]));
    expect(cut).toHaveLength(1);
    expect(cut[0].points.length / 3).toBe(2);
    expect(cut[0].arcLength[1]).toBeCloseTo(1, 6);
  });

  it('drops a plane that only grazes a vertex', () => {
    // The +Z face sits at z = 0.3; a plane there touches the walls along their top
    // edges, so what comes back is that face's outline, never a stray spike.
    const cut = sectionModel(boxModel(), plane([0, 0, 1], [0, 0, BOX[2]]));
    expect(cut).toHaveLength(1);
    expect(cut[0].arcLength[cut[0].arcLength.length - 1]).toBeCloseTo(BOX_PERIMETER, 6);
  });
});
