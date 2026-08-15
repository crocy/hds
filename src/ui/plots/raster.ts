/**
 * Pixel buffers for the two plots that cannot be SVG: the 100k-point scatter and
 * the filled section field.
 *
 * Both write RGBA into a caller-owned buffer, so the component only has to hand the
 * result to `putImageData`. Keeping them DOM-free makes the rules that actually
 * matter — outside cells stay transparent, unreachable nodes are skipped, dense
 * clusters saturate — unit-testable without a canvas.
 *
 * Colour comes from `viewer/colormap` so the plots and the 3D view speak one
 * colour language. `viewer/colormap` is imported directly rather than through the
 * `@/viewer` facade, which would pull three.js into the plot bundle.
 */

import type { ColormapId } from '@/core/types';
import { CELL_OUTSIDE } from '@/core/types';
import { normalize, sample } from '@/viewer/colormap';
import { scaleValue, type LinearScale } from './scales';

export interface RgbaBuffer {
  /** Backed by a plain ArrayBuffer, so it can be handed straight to `new ImageData`. */
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

export function createRgbaBuffer(width: number, height: number): RgbaBuffer {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
}

function reuseOrCreate(out: RgbaBuffer | undefined, width: number, height: number): RgbaBuffer {
  if (out && out.width === width && out.height === height) {
    out.data.fill(0);
    return out;
  }
  return createRgbaBuffer(width, height);
}

export interface ColorRange {
  map: ColormapId;
  /** kelvin */
  min: number;
  max: number;
}

/** Structurally satisfied by `SectionField2D`. */
export interface RasterisableField {
  width: number;
  height: number;
  values: ArrayLike<number>;
  mask?: ArrayLike<number>;
}

/**
 * Grid → RGBA, flipped vertically: the grid's v axis grows upward, a canvas row
 * index grows downward.
 *
 * Cells outside the model and cells with a non-finite value are left fully
 * transparent. Painting them black would read as "0 °C here", which is a lie about
 * a region the solve says nothing about.
 */
export function rasteriseField(
  field: RasterisableField,
  range: ColorRange,
  out?: RgbaBuffer,
): RgbaBuffer {
  const { width, height, values, mask } = field;
  const buffer = reuseOrCreate(out, width, height);
  if (width < 1 || height < 1) return buffer;

  const data = buffer.data;
  for (let row = 0; row < height; row++) {
    const flipped = height - 1 - row;
    for (let column = 0; column < width; column++) {
      const source = row * width + column;
      const value = values[source];
      if (!Number.isFinite(value)) continue;
      if (mask && mask[source] === CELL_OUTSIDE) continue;

      const [r, g, b] = sample(range.map, normalize(value, range.min, range.max));
      const target = (flipped * width + column) * 4;
      data[target] = r * 255;
      data[target + 1] = g * 255;
      data[target + 2] = b * 255;
      data[target + 3] = 255;
    }
  }
  return buffer;
}

export interface ScatterStyle extends ColorRange {
  /** Per-point opacity, 0..1. Below 1, overlapping points accumulate toward full colour. */
  alpha: number;
  /** Half-size of the square stamp in buffer pixels. 0 draws a single pixel. */
  radius: number;
}

/**
 * Source-over compositing with straight (non-premultiplied) alpha. Doing this by
 * hand rather than with 100k `fillRect` calls keeps a resize under a frame, and
 * lets the density of the cloud carry information the way the reference figure's
 * scatter does.
 */
function blendPixel(
  data: Uint8ClampedArray<ArrayBuffer>,
  offset: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
): void {
  const destAlpha = data[offset + 3] / 255;
  const outAlpha = alpha + destAlpha * (1 - alpha);
  if (outAlpha <= 0) return;
  const sourceWeight = alpha / outAlpha;
  const destWeight = (destAlpha * (1 - alpha)) / outAlpha;
  data[offset] = r * 255 * sourceWeight + data[offset] * destWeight;
  data[offset + 1] = g * 255 * sourceWeight + data[offset + 1] * destWeight;
  data[offset + 2] = b * 255 * sourceWeight + data[offset + 2] * destWeight;
  data[offset + 3] = outAlpha * 255;
}

/**
 * Draws (x, y) pairs into `target`, coloured by `value` through the shared colormap.
 * `xScale`/`yScale` map data units to buffer pixels.
 *
 * Points with a non-finite coordinate are skipped: nodes the conduction graph never
 * reached carry an infinite path length and belong in no bin of this plot.
 *
 * Returns the number of points actually drawn, which the caller can report.
 */
export function rasteriseScatter(
  target: RgbaBuffer,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  value: ArrayLike<number>,
  xScale: LinearScale,
  yScale: LinearScale,
  style: ScatterStyle,
): number {
  const { data, width, height } = target;
  const length = Math.min(x.length, y.length, value.length);
  const radius = Math.max(0, Math.floor(style.radius));
  const alpha = Math.max(0, Math.min(1, style.alpha));
  if (alpha === 0) return 0;

  let drawn = 0;
  for (let i = 0; i < length; i++) {
    const xi = x[i];
    const yi = y[i];
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;

    const centreX = Math.round(scaleValue(xScale, xi));
    const centreY = Math.round(scaleValue(yScale, yi));
    if (!Number.isFinite(centreX) || !Number.isFinite(centreY)) continue;
    if (centreX + radius < 0 || centreX - radius >= width) continue;
    if (centreY + radius < 0 || centreY - radius >= height) continue;

    const [r, g, b] = sample(style.map, normalize(value[i], style.min, style.max));
    const left = Math.max(0, centreX - radius);
    const right = Math.min(width - 1, centreX + radius);
    const top = Math.max(0, centreY - radius);
    const bottom = Math.min(height - 1, centreY + radius);
    for (let py = top; py <= bottom; py++) {
      for (let px = left; px <= right; px++) {
        blendPixel(data, (py * width + px) * 4, r, g, b, alpha);
      }
    }
    drawn++;
  }
  return drawn;
}
