/**
 * Area above a temperature — spec §7.4. "X cm² exceeds 55 °C", broken down by part,
 * plus the histogram of surface area by temperature behind it.
 *
 * Area is attributed per triangle at the mean of its three node temperatures. The
 * shell field is linear across a facet, and the mean of the vertex values is exactly
 * that field's average over the facet — so a triangle counts once, at its average
 * temperature, rather than being split at the threshold contour.
 */

import type { ThermalModel, ThresholdResult } from '../core/types';

export const DEFAULT_HISTOGRAM_BINS = 32;

export interface ThresholdOptions {
  binCount?: number;
  /** Histogram range, kelvin. Defaults to the coldest and hottest triangle. */
  min?: number;
  max?: number;
}

/**
 * Triangles whose temperature is not finite are left out of every total, including
 * `totalArea`, so the histogram always sums to `totalArea`.
 */
export function areaAboveThreshold(
  model: ThermalModel,
  temperature: ArrayLike<number>,
  threshold: number,
  options: ThresholdOptions = {},
): ThresholdResult {
  const { triCount, triArea, triPart, tris, parts } = model;
  const triTemperature = new Float64Array(triCount);
  const perPartArea = new Float64Array(parts.length);
  let totalArea = 0;
  let areaAbove = 0;
  let coldest = Infinity;
  let hottest = -Infinity;

  for (let t = 0; t < triCount; t++) {
    const mean =
      (temperature[tris[t * 3]] + temperature[tris[t * 3 + 1]] + temperature[tris[t * 3 + 2]]) / 3;
    triTemperature[t] = mean;
    if (!Number.isFinite(mean)) continue;
    const area = triArea[t];
    totalArea += area;
    if (mean < coldest) coldest = mean;
    if (mean > hottest) hottest = mean;
    // At or above: areaAbove(coldest) is then the whole surface, with no gap.
    if (mean >= threshold) {
      areaAbove += area;
      const part = triPart[t];
      if (part < perPartArea.length) perPartArea[part] += area;
    }
  }

  const binCount = Math.max(1, Math.floor(options.binCount ?? DEFAULT_HISTOGRAM_BINS));
  const range = histogramRange(options.min ?? coldest, options.max ?? hottest);
  const binEdges = new Float32Array(binCount + 1);
  for (let b = 0; b <= binCount; b++) {
    binEdges[b] = range.min + ((range.max - range.min) * b) / binCount;
  }
  const areaPerBin = new Float32Array(binCount);
  for (let t = 0; t < triCount; t++) {
    const mean = triTemperature[t];
    if (!Number.isFinite(mean)) continue;
    // Anything outside an explicitly set range lands in the end bin it is nearest,
    // so the bars still add up to the surface area they were measured from.
    const bin = Math.min(
      binCount - 1,
      Math.max(0, Math.floor(((mean - range.min) / (range.max - range.min)) * binCount)),
    );
    areaPerBin[bin] += triArea[t];
  }

  return {
    threshold,
    areaAbove,
    totalArea,
    perPart: parts.map((part, index) => ({ partId: part.id, areaAbove: perPartArea[index] })),
    histogram: { binEdges, areaPerBin },
  };
}

/** A uniform field, or one with no usable temperatures at all, still needs a bin to fall into. */
function histogramRange(min: number, max: number): { min: number; max: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (max > min) return { min, max };
  return { min: min - 0.5, max: min + 0.5 };
}
