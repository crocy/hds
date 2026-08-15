/**
 * Approximation: conduction is solved *in the cut plane only* and all out-of-plane
 * flux is ignored, so this is not a 3D result — the volumetric backend supersedes it.
 *
 * The filled cut-plane field of spec §7.1. Sectioning is not done here: the caller
 * passes the polylines from `geometry/section`, so the same cut feeds both the
 * profile plot and this one.
 *
 * ## Cell classification
 *
 * Samples sit at cell centres, matching `marchingSquares`.
 *
 * - `CELL_SHELL` — a section segment passes through the cell. The cell holds the
 *   segment's interpolated wall temperature and is a Dirichlet condition.
 * - `CELL_CAVITY` — the cell is enclosed by the section: inside an odd number of
 *   closed polylines, or inside an odd number of the polylines that wall off a
 *   cavity. The second test is what rescues a thick-walled housing, whose outer and
 *   inner walls both cut the plane and whose trapped air is therefore inside two
 *   loops. These cells are the unknowns of the solve.
 * - `CELL_AMBIENT` — outside the section entirely: open air, pinned to ambient.
 * - `CELL_OUTSIDE` — no temperature at all, written as NaN so the renderer skips it:
 *   an enclosed region with an adiabatic fill, or one the boundary data never
 *   reaches. Shell cells cut from a section with no temperature field are NaN too,
 *   and a NaN neighbour carries no flux.
 */

import {
  CELL_AMBIENT,
  CELL_CAVITY,
  CELL_OUTSIDE,
  CELL_SHELL,
  type SectionField2D,
  type SectionPolyline,
} from '../core/types';
import type { PlaneBasis } from '../geometry/section';
import { contourLevels } from './marchingSquares';

export const DEFAULT_SLICE_RESOLUTION = 256;
export const DEFAULT_CONTOUR_COUNT = 6;
/** All four flux bits set. */
const ALL_NEIGHBOURS = 15;
/** Gauss–Seidel stops when no cell moves more than this in a sweep, kelvin. */
export const DEFAULT_SLICE_TOLERANCE = 1e-4;
export const DEFAULT_SLICE_MAX_ITERATIONS = 1000;

export interface PlaneExtent {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

/** `geometry/section` supplies `cavityId`; a bare `SectionPolyline` reads as open air. */
export type SlicePolyline = SectionPolyline & { cavityId?: number };

export interface Slice2DOptions {
  /** Plane-space region to rasterise, metres. */
  extent: PlaneExtent;
  /** kelvin */
  ambient: number;
  /**
   * Conductivity of whatever fills the enclosed region, W/(m·K). A uniform fill
   * cancels out of a Dirichlet Laplace problem — ∇·(k∇T) = 0 collapses to ∇²T = 0 —
   * so this decides only whether the fill conducts at all: an adiabatic cavity
   * (fillK = 0) has no field, and its cells stay NaN.
   */
  fillK: number;
  /** Default 256 each. */
  width?: number;
  height?: number;
  /** Contour levels, kelvin. Default: six levels spread across the solved range. */
  contours?: readonly number[];
  tolerance?: number;
  maxIterations?: number;
}

interface PlaneLoop {
  u: Float64Array;
  v: Float64Array;
  temperature: Float64Array;
  closed: boolean;
  cavity: boolean;
}

export function solveSliceField(
  polylines: readonly SlicePolyline[],
  basis: PlaneBasis,
  options: Slice2DOptions,
): SectionField2D {
  const width = Math.max(2, Math.floor(options.width ?? DEFAULT_SLICE_RESOLUTION));
  const height = Math.max(2, Math.floor(options.height ?? DEFAULT_SLICE_RESOLUTION));
  const { uMin, uMax, vMin, vMax } = options.extent;
  const du = (uMax - uMin) / width;
  const dv = (vMax - vMin) / height;
  if (!(du > 0) || !(dv > 0)) {
    throw new Error('slice extent must be positive in both plane axes');
  }

  const cellCount = width * height;
  const values = new Float32Array(cellCount).fill(NaN);
  const mask = new Uint8Array(cellCount);
  const grid: GridGeometry = { width, height, uMin, vMin, du, dv };
  const loops = projectPolylines(polylines, basis);

  classifyEnclosedCells(loops, mask, grid);
  for (let c = 0; c < cellCount; c++) {
    if (mask[c] === CELL_CAVITY) continue;
    mask[c] = CELL_AMBIENT;
    values[c] = options.ambient;
  }
  rasteriseShell(loops, mask, values, grid);

  const unknowns = collectSolvableCells(mask, values, width, height, options.fillK);
  const stencil = buildStencil(unknowns, mask, values, grid, options.ambient);
  relax(stencil, {
    tolerance: options.tolerance ?? DEFAULT_SLICE_TOLERANCE,
    maxIterations: options.maxIterations ?? DEFAULT_SLICE_MAX_ITERATIONS,
  });
  for (const cell of unknowns) values[cell] = stencil.work[cell];

  const field = { width, height, uMin, uMax, vMin, vMax, values };
  return {
    ...field,
    mask,
    contours: contourLevels(field, options.contours ?? defaultLevels(values)),
  };
}

function projectPolylines(polylines: readonly SlicePolyline[], basis: PlaneBasis): PlaneLoop[] {
  const loops: PlaneLoop[] = [];
  for (const polyline of polylines) {
    const count = polyline.points.length / 3;
    if (count < 2) continue;
    const u = new Float64Array(count + 1);
    const v = new Float64Array(count + 1);
    const temperature = new Float64Array(count + 1);
    for (let k = 0; k < count; k++) {
      const [pu, pv] = basis.projectToPlane(polyline.points, k * 3);
      u[k] = pu;
      v[k] = pv;
      temperature[k] = polyline.temperature[k];
    }
    // Section polylines already repeat their first point; close anything that does
    // not, or a scanline through the gap would see an odd number of crossings.
    const gap = polyline.closed && (u[count - 1] !== u[0] || v[count - 1] !== v[0]);
    const total = gap ? count + 1 : count;
    if (gap) {
      u[count] = u[0];
      v[count] = v[0];
      temperature[count] = temperature[0];
    }
    loops.push({
      u: u.subarray(0, total),
      v: v.subarray(0, total),
      temperature: temperature.subarray(0, total),
      closed: polyline.closed,
      cavity: (polyline.cavityId ?? 0) !== 0,
    });
  }
  return loops;
}

interface GridGeometry {
  width: number;
  height: number;
  uMin: number;
  vMin: number;
  du: number;
  dv: number;
}

/** Even-odd scanline through the cell centres of each row. */
function classifyEnclosedCells(loops: PlaneLoop[], mask: Uint8Array, grid: GridGeometry): void {
  const { width, height, uMin, vMin, du, dv } = grid;
  const closedLoops = loops.filter((loop) => loop.closed);
  if (closedLoops.length === 0) return;

  const acrossAll: number[] = [];
  const acrossCavities: number[] = [];
  const markSpans = (crossings: number[], row: number) => {
    if (crossings.length < 2) return;
    crossings.sort((a, b) => a - b);
    for (let c = 0; c + 1 < crossings.length; c += 2) {
      const from = Math.max(0, Math.ceil((crossings[c] - uMin) / du - 0.5));
      const to = Math.min(width - 1, Math.floor((crossings[c + 1] - uMin) / du - 0.5));
      for (let i = from; i <= to; i++) mask[row * width + i] = CELL_CAVITY;
    }
  };

  for (let j = 0; j < height; j++) {
    const v = vMin + (j + 0.5) * dv;
    acrossAll.length = 0;
    acrossCavities.length = 0;
    for (const loop of closedLoops) {
      for (let k = 0; k + 1 < loop.u.length; k++) {
        const va = loop.v[k];
        const vb = loop.v[k + 1];
        if (va <= v === vb <= v) continue;
        const u = loop.u[k] + ((v - va) / (vb - va)) * (loop.u[k + 1] - loop.u[k]);
        acrossAll.push(u);
        if (loop.cavity) acrossCavities.push(u);
      }
    }
    markSpans(acrossAll, j);
    markSpans(acrossCavities, j);
  }
}

/**
 * Walks each segment at a fraction of a cell so no cell it passes through is
 * missed; a cell holding several samples takes their mean.
 */
function rasteriseShell(
  loops: PlaneLoop[],
  mask: Uint8Array,
  values: Float32Array,
  grid: GridGeometry,
): void {
  const { width, height, uMin, vMin, du, dv } = grid;
  const sum = new Float64Array(width * height);
  const samples = new Uint32Array(width * height);
  const step = 0.3 * Math.min(du, dv);

  for (const loop of loops) {
    for (let k = 0; k + 1 < loop.u.length; k++) {
      const u0 = loop.u[k];
      const v0 = loop.v[k];
      const du01 = loop.u[k + 1] - u0;
      const dv01 = loop.v[k + 1] - v0;
      const t0 = loop.temperature[k];
      const dt01 = loop.temperature[k + 1] - t0;
      const steps = Math.max(1, Math.ceil(Math.hypot(du01, dv01) / step));
      for (let s = 0; s <= steps; s++) {
        const f = s / steps;
        const i = Math.floor((u0 + f * du01 - uMin) / du);
        const j = Math.floor((v0 + f * dv01 - vMin) / dv);
        if (i < 0 || i >= width || j < 0 || j >= height) continue;
        const cell = j * width + i;
        sum[cell] += t0 + f * dt01;
        samples[cell]++;
      }
    }
  }

  for (let cell = 0; cell < samples.length; cell++) {
    if (samples[cell] === 0) continue;
    mask[cell] = CELL_SHELL;
    values[cell] = sum[cell] / samples[cell];
  }
}

/**
 * Enclosed cells the boundary data can actually reach. A pocket with no Dirichlet
 * neighbour — or any enclosed cell at all when the fill cannot conduct — has no
 * temperature, and says so with NaN rather than with a plausible-looking number.
 */
function collectSolvableCells(
  mask: Uint8Array,
  values: Float32Array,
  width: number,
  height: number,
  fillK: number,
): Uint32Array {
  const cellCount = width * height;
  const reachable = new Uint8Array(cellCount);
  const queue = new Uint32Array(cellCount);
  let head = 0;
  let tail = 0;
  const spread = (next: number) => {
    if (reachable[next] || mask[next] !== CELL_CAVITY) return;
    reachable[next] = 1;
    queue[tail++] = next;
  };

  if (fillK > 0) {
    for (let cell = 0; cell < cellCount; cell++) {
      if (mask[cell] !== CELL_CAVITY) continue;
      const i = cell % width;
      const j = (cell / width) | 0;
      const driven =
        (i > 0 && Number.isFinite(values[cell - 1])) ||
        (i < width - 1 && Number.isFinite(values[cell + 1])) ||
        (j > 0 && Number.isFinite(values[cell - width])) ||
        (j < height - 1 && Number.isFinite(values[cell + width]));
      if (!driven) continue;
      reachable[cell] = 1;
      queue[tail++] = cell;
    }
    while (head < tail) {
      const cell = queue[head++];
      const i = cell % width;
      const j = (cell / width) | 0;
      if (i > 0) spread(cell - 1);
      if (i < width - 1) spread(cell + 1);
      if (j > 0) spread(cell - width);
      if (j < height - 1) spread(cell + width);
    }
  }

  const cells: number[] = [];
  for (let cell = 0; cell < cellCount; cell++) {
    if (mask[cell] !== CELL_CAVITY) continue;
    if (reachable[cell]) cells.push(cell);
    else {
      mask[cell] = CELL_OUTSIDE;
      values[cell] = NaN;
    }
  }
  return Uint32Array.from(cells);
}

interface Stencil {
  cells: Uint32Array;
  /** Row stride of the grid the cell indices point into. */
  width: number;
  /** Bit per neighbour that carries flux: 1 west, 2 east, 4 south, 8 north. */
  flux: Uint8Array;
  /** 1 / Σ w over the neighbours that carry flux. */
  inverseWeight: Float64Array;
  /**
   * The whole grid in double precision, Dirichlet cells included. Iterating at
   * float32 would not work: a sweep of a 400 K field cannot resolve a change below
   * ~3·10⁻⁵ K there, so the stopping test would never fire.
   */
  work: Float64Array;
  wu: number;
  wv: number;
  /** Extent of the solved region in cells, which sets the relaxation factor. */
  spanU: number;
  spanV: number;
}

/**
 * Precomputes the five-point stencil. Off-grid, NaN and unsolved neighbours drop out
 * of both the numerator and the weight, which is a zero-flux edge.
 */
function buildStencil(
  cells: Uint32Array,
  mask: Uint8Array,
  values: Float32Array,
  grid: GridGeometry,
  seed: number,
): Stencil {
  const { width, height, du, dv } = grid;
  const wu = 1 / (du * du);
  const wv = 1 / (dv * dv);
  const count = cells.length;
  const flux = new Uint8Array(count);
  const inverseWeight = new Float64Array(count);
  const work = Float64Array.from(values);
  for (let k = 0; k < count; k++) work[cells[k]] = seed;

  let minU = width;
  let maxU = 0;
  let minV = height;
  let maxV = 0;
  for (let k = 0; k < count; k++) {
    const cell = cells[k];
    const i = cell % width;
    const j = (cell / width) | 0;
    if (i < minU) minU = i;
    if (i > maxU) maxU = i;
    if (j < minV) minV = j;
    if (j > maxV) maxV = j;
    let bits = 0;
    let weight = 0;
    if (i > 0 && Number.isFinite(work[cell - 1])) {
      bits |= 1;
      weight += wu;
    }
    if (i < width - 1 && Number.isFinite(work[cell + 1])) {
      bits |= 2;
      weight += wu;
    }
    if (j > 0 && Number.isFinite(work[cell - width])) {
      bits |= 4;
      weight += wv;
    }
    if (j < height - 1 && Number.isFinite(work[cell + width])) {
      bits |= 8;
      weight += wv;
    }
    flux[k] = bits;
    inverseWeight[k] = weight > 0 ? 1 / weight : 0;
  }
  return {
    cells,
    width,
    flux,
    inverseWeight,
    work,
    wu,
    wv,
    spanU: Math.max(2, maxU - minU + 1),
    spanV: Math.max(2, maxV - minV + 1),
  };
}

interface RelaxOptions {
  tolerance: number;
  maxIterations: number;
}

/** Gauss–Seidel with over-relaxation at the ω that is optimal for a region this size. */
function relax(stencil: Stencil, options: RelaxOptions): void {
  const { cells, width, flux, inverseWeight, work, wu, wv, spanU, spanV } = stencil;
  const { tolerance, maxIterations } = options;
  const count = cells.length;
  if (count === 0) return;

  // ω from the solved region's own size, not the grid's: a region half the width
  // needs a noticeably smaller ω, and using the grid's costs a quarter more sweeps.
  const spectralRadius =
    (wu * Math.cos(Math.PI / spanU) + wv * Math.cos(Math.PI / spanV)) / (wu + wv);
  const omega = 2 / (1 + Math.sqrt(Math.max(0, 1 - spectralRadius * spectralRadius)));

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let largestChange = 0;
    for (let k = 0; k < count; k++) {
      const cell = cells[k];
      const bits = flux[k];
      let sum = 0;
      if (bits === ALL_NEIGHBOURS) {
        // Every cell away from the wall, which is nearly all of them.
        sum =
          wu * (work[cell - 1] + work[cell + 1]) + wv * (work[cell - width] + work[cell + width]);
      } else {
        if (bits & 1) sum += wu * work[cell - 1];
        if (bits & 2) sum += wu * work[cell + 1];
        if (bits & 4) sum += wv * work[cell - width];
        if (bits & 8) sum += wv * work[cell + width];
      }
      const change = omega * (sum * inverseWeight[k] - work[cell]);
      work[cell] += change;
      largestChange = Math.max(largestChange, change < 0 ? -change : change);
    }
    if (largestChange < tolerance) break;
  }
}

function defaultLevels(values: Float32Array): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!(max > min)) return [];
  const levels: number[] = [];
  for (let k = 1; k <= DEFAULT_CONTOUR_COUNT; k++) {
    levels.push(min + ((max - min) * k) / (DEFAULT_CONTOUR_COUNT + 1));
  }
  return levels;
}
