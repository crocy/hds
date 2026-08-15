import { describe, expect, it } from 'vitest';
import { boxMesh, modelFromMesh, stripMesh, twoStripModel } from '../core/testModels';
import type { Vec3 } from '../core/types';
import { areaAboveThreshold } from './threshold';

/**
 * The unit square as two triangles of 0.5 m² each. Node 2 alone is hot, which puts
 * the (0,3,2) triangle at a mean of 400 K and the (0,1,3) triangle at 300 K.
 */
function twoTriangleSquare() {
  const model = modelFromMesh(stripMesh(1, 1, 1, 1));
  const temperature = Float32Array.from([300, 300, 600, 300]);
  return { model, temperature };
}

function sumOf(values: ArrayLike<number>): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i];
  return total;
}

describe('areaAboveThreshold', () => {
  it('matches the hand-computed area on a known field', () => {
    const { model, temperature } = twoTriangleSquare();
    expect(areaAboveThreshold(model, temperature, 350).areaAbove).toBeCloseTo(0.5, 6);
    expect(areaAboveThreshold(model, temperature, 250).areaAbove).toBeCloseTo(1, 6);
    expect(areaAboveThreshold(model, temperature, 450).areaAbove).toBe(0);
    // The threshold is inclusive, so a triangle sitting exactly on it counts.
    expect(areaAboveThreshold(model, temperature, 400).areaAbove).toBeCloseTo(0.5, 6);
    expect(areaAboveThreshold(model, temperature, 300).areaAbove).toBeCloseTo(1, 6);
  });

  it('reports the total area independently of the threshold', () => {
    const { model, temperature } = twoTriangleSquare();
    for (const threshold of [0, 300, 350, 1000]) {
      expect(areaAboveThreshold(model, temperature, threshold).totalArea).toBeCloseTo(1, 6);
    }
  });

  it('bins the whole surface area of a box', () => {
    const size: Vec3 = [0.2, 0.1, 0.3];
    const model = modelFromMesh(boxMesh(size));
    const surfaceArea = 2 * (size[0] * size[1] + size[1] * size[2] + size[0] * size[2]);
    const temperature = new Float32Array(model.nodeCount);
    for (let n = 0; n < model.nodeCount; n++) {
      temperature[n] = 300 + (100 * model.nodes[n * 3 + 2]) / size[2];
    }

    const result = areaAboveThreshold(model, temperature, 350);
    expect(result.totalArea).toBeCloseTo(surfaceArea, 6);
    expect(sumOf(result.histogram.areaPerBin)).toBeCloseTo(surfaceArea, 6);
    expect(result.histogram.binEdges).toHaveLength(33);
    expect(result.histogram.binEdges[0]).toBeCloseTo(300, 4);
    expect(result.histogram.binEdges[32]).toBeCloseTo(400, 4);
    expect(result.areaAbove).toBeGreaterThan(0);
    expect(result.areaAbove).toBeLessThan(surfaceArea);
  });

  it('splits the area by part', () => {
    const model = twoStripModel(0.1, 0.02, 5);
    const temperature = new Float32Array(model.nodeCount);
    for (let n = 0; n < model.nodeCount; n++) {
      temperature[n] = model.nodePart[n] === 0 ? 500 : 300;
    }
    const result = areaAboveThreshold(model, temperature, 400);
    expect(result.perPart).toHaveLength(2);
    expect(result.perPart[0]).toEqual({ partId: 'part-0', areaAbove: expect.closeTo(0.002, 9) });
    expect(result.perPart[1].areaAbove).toBe(0);
    expect(result.areaAbove).toBeCloseTo(result.totalArea / 2, 9);
  });

  it('honours an explicit histogram range and bin count', () => {
    const { model, temperature } = twoTriangleSquare();
    const result = areaAboveThreshold(model, temperature, 350, {
      binCount: 4,
      min: 320,
      max: 360,
    });
    expect(result.histogram.areaPerBin).toHaveLength(4);
    expect(Array.from(result.histogram.binEdges)).toEqual([320, 330, 340, 350, 360]);
    // 300 K clamps into the first bin and 400 K into the last, so nothing is lost.
    expect(result.histogram.areaPerBin[0]).toBeCloseTo(0.5, 6);
    expect(result.histogram.areaPerBin[3]).toBeCloseTo(0.5, 6);
    expect(sumOf(result.histogram.areaPerBin)).toBeCloseTo(result.totalArea, 6);
  });

  it('keeps a uniform field inside a usable bin range', () => {
    const model = modelFromMesh(stripMesh(1, 1, 1, 1));
    const result = areaAboveThreshold(model, new Float32Array(model.nodeCount).fill(350), 300);
    expect(result.areaAbove).toBeCloseTo(1, 6);
    expect(result.histogram.binEdges[0]).toBeLessThan(350);
    expect(result.histogram.binEdges[32]).toBeGreaterThan(350);
    expect(sumOf(result.histogram.areaPerBin)).toBeCloseTo(1, 6);
  });

  it('drops triangles with no usable temperature', () => {
    const { model, temperature } = twoTriangleSquare();
    temperature[2] = NaN;
    const result = areaAboveThreshold(model, temperature, 250);
    expect(result.totalArea).toBeCloseTo(0.5, 6);
    expect(result.areaAbove).toBeCloseTo(0.5, 6);
    expect(sumOf(result.histogram.areaPerBin)).toBeCloseTo(0.5, 6);
  });
});
