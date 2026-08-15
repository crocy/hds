/**
 * Contour extraction from a 2D scalar grid — the white lines over the cut-plane
 * field. Samples sit at cell centres, matching how `slice2d` rasterises.
 */

/** Structurally satisfied by `SectionField2D`, so a field can be passed straight in. */
export interface ScalarGrid {
  width: number;
  height: number;
  /** Row-major, values[j * width + i]. NaN marks a cell with no data. */
  values: ArrayLike<number>;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

export interface ContourLevel {
  level: number;
  /** Line segments as x0, y0, x1, y1 quadruples in plane coordinates. */
  segments: Float32Array;
}

/**
 * Interpolate along a cell edge from (ua, va) to (ub, vb). Both endpoints are
 * finite and straddle `level`, so the denominator cannot vanish.
 */
function crossing(a: number, b: number, level: number): number {
  return (level - a) / (b - a);
}

export function marchingSquares(grid: ScalarGrid, level: number): Float32Array {
  const { width, height, values } = grid;
  if (width < 2 || height < 2) return new Float32Array(0);
  const du = (grid.uMax - grid.uMin) / width;
  const dv = (grid.vMax - grid.vMin) / height;
  const u = (i: number) => grid.uMin + (i + 0.5) * du;
  const v = (j: number) => grid.vMin + (j + 0.5) * dv;

  const out: number[] = [];
  for (let j = 0; j < height - 1; j++) {
    for (let i = 0; i < width - 1; i++) {
      // Corners counter-clockwise from bottom-left.
      const bl = values[j * width + i];
      const br = values[j * width + i + 1];
      const tr = values[(j + 1) * width + i + 1];
      const tl = values[(j + 1) * width + i];
      if (!Number.isFinite(bl) || !Number.isFinite(br) || !Number.isFinite(tr)) continue;
      if (!Number.isFinite(tl)) continue;

      let code = 0;
      if (bl >= level) code |= 1;
      if (br >= level) code |= 2;
      if (tr >= level) code |= 4;
      if (tl >= level) code |= 8;
      if (code === 0 || code === 15) continue;

      const u0 = u(i);
      const u1 = u(i + 1);
      const v0 = v(j);
      const v1 = v(j + 1);
      const bottom: [number, number] = [u0 + crossing(bl, br, level) * du, v0];
      const right: [number, number] = [u1, v0 + crossing(br, tr, level) * dv];
      const top: [number, number] = [u0 + crossing(tl, tr, level) * du, v1];
      const left: [number, number] = [u0, v0 + crossing(bl, tl, level) * dv];
      const push = (a: [number, number], b: [number, number]) => out.push(a[0], a[1], b[0], b[1]);

      switch (code) {
        case 1:
        case 14:
          push(left, bottom);
          break;
        case 2:
        case 13:
          push(bottom, right);
          break;
        case 3:
        case 12:
          push(left, right);
          break;
        case 4:
        case 11:
          push(right, top);
          break;
        case 6:
        case 9:
          push(bottom, top);
          break;
        case 7:
        case 8:
          push(left, top);
          break;
        // Saddles: the cell average decides which diagonal pair gets cut off.
        case 5:
        case 10: {
          const centre = (bl + br + tr + tl) / 4;
          const cutBottomLeftAndTopRight = (code === 5) === centre < level;
          if (cutBottomLeftAndTopRight) {
            push(left, bottom);
            push(right, top);
          } else {
            push(left, top);
            push(bottom, right);
          }
          break;
        }
      }
    }
  }
  return Float32Array.from(out);
}

export function contourLevels(grid: ScalarGrid, levels: readonly number[]): ContourLevel[] {
  return levels.map((level) => ({ level, segments: marchingSquares(grid, level) }));
}
