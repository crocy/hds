/**
 * Voxelisation of a closed part's interior — the geometry behind a volumetric solve.
 *
 * The shell solver conducts *in plane*, along a part's surface, with `k × thickness`.
 * For a 1 mm steel sheet that is the whole truth: Bi = h·t/k ≈ 5e-4, so the sheet is
 * isothermal through its thickness and there is no gradient to miss. For a 40 mm block
 * of glass wool the same number is ≈ 9, and the through-thickness gradient *is* the
 * part — its entire purpose is to drop 180 K across itself. A surface-only model gives
 * that heat a path along the skin instead, which is a short circuit around the very
 * resistance the part exists to provide.
 *
 * So a `solid` part is filled with cells on a regular grid and conducts through them.
 * Regular cells, not tetrahedra, because the grid needs no mesher: the inside test is
 * a ray-parity count against the part's own shell, which the BVH already answers, and
 * a cubic cell's conductances are `k·d` between neighbours with no shape functions.
 * The cost is that a curved boundary is staircased, which is a poor way to spend cells
 * on a shape whose surface matters and a fine one on a slab whose thickness matters.
 *
 * What comes back is geometry only — cells, who neighbours whom, and where the cells
 * meet the surface. Conductances are the physics module's to compute, so this file
 * knows nothing about materials.
 */

import type { ThermalModel } from '../core/types';
import {
  buildBvh,
  closestPointInto,
  countRayHits,
  createClosestPointResult,
  type Bvh,
  type ClosestPointOptions,
  type RaycastOptions,
} from './bvh';
import { clusterPoints } from './spatialHash';

/**
 * Parity directions: three skew rays, deliberately not axis-aligned.
 *
 * An axis-aligned ray from a cell centre runs straight down the diagonal a quad's two
 * triangles share, and the BVH counts that as two hits on purpose — its edge slack
 * exists so a ray through a shared edge hits both triangles rather than neither. That
 * is right for occlusion and fatal for parity, which then reads a solid cell as empty.
 * Skew directions meet a shared edge only by coincidence, and three of them voting
 * turn the coincidence into a lone dissent.
 */
const PARITY_DIRECTIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0.5628, 0.7237, 0.4009],
  [-0.8135, 0.3472, 0.4661],
  [0.2971, -0.5619, 0.7723],
];

/**
 * Cells across the part's own thickness. Four puts three interior faces in the wall,
 * which resolves a linear gradient exactly and a curved one adequately; the resistance
 * itself is exact at any count, because a series of cells sums to the same `t/(kA)`.
 */
export const DEFAULT_CELLS_ACROSS_THICKNESS = 4;

/**
 * Cap on the grid, so a thin feature in a big bounding box cannot ask for a billion
 * cells. Hit, the cell size grows and the warning says the wall is under-resolved.
 */
export const DEFAULT_MAX_CELLS = 400_000;

export interface VolumeOptions {
  /** Metres. Overrides the size derived from the part's thickness. */
  cellSize?: number;
  cellsAcrossThickness?: number;
  maxCells?: number;
  /** Position tolerance for matching shared edges. Default 1e-6 × the part's diagonal. */
  weldTolerance?: number;
  /** Reuse a BVH already built over this model. */
  bvh?: Bvh;
}

export interface VolumeMesh {
  partIndex: number;
  /** Cube edge, metres. */
  cellSize: number;
  cellCount: number;
  /** Cell centres, xyz interleaved. length = 3 × cellCount */
  centres: Float64Array;
  /** Undirected cell-to-cell faces: `links[2i]` ↔ `links[2i + 1]`. */
  links: Uint32Array;
  /**
   * Cell faces that lie on the part's surface, each paired with the surface triangle
   * nearest it. This is how the interior reaches the rest of the model: the cell links
   * to that triangle's three corner nodes, which are the DOFs contacts, convection and
   * radiation already attach to.
   */
  boundaryCell: Uint32Array;
  boundaryTriangle: Uint32Array;
  /**
   * node → the cell it sits on, or −1 for every node outside this part.
   *
   * A surface node of a filled part is not a temperature of its own: it *is* the cell
   * behind it, and shares its DOF. Giving it a separate one and tying it to the cells
   * along its triangle would put every cell under a coarse facet on a common
   * temperature — a short along the skin, which is the very thing filling the part is
   * meant to remove.
   */
  nodeCell: Int32Array;
  /** True when `maxCells` forced a coarser grid than `cellsAcrossThickness` asked for. */
  coarsened: boolean;
}

const EMPTY_VOLUME = (partIndex: number, cellSize: number): VolumeMesh => ({
  partIndex,
  cellSize,
  cellCount: 0,
  centres: new Float64Array(0),
  links: new Uint32Array(0),
  boundaryCell: new Uint32Array(0),
  boundaryTriangle: new Uint32Array(0),
  nodeCell: new Int32Array(0),
  coarsened: false,
});

/**
 * Fills one part's interior with cells.
 *
 * Returns an empty mesh when the part encloses nothing the grid can find — an open
 * shell, or a wall thinner than one cell. The caller has to treat that as "no
 * volumetric path" and say so, because a solid part whose cells went missing would
 * otherwise be a part whose heat has nowhere to go.
 */
export function buildVolumeMesh(
  model: ThermalModel,
  partIndex: number,
  options: VolumeOptions = {},
): VolumeMesh {
  const part = model.parts[partIndex];
  if (!part) throw new Error(`no part at index ${partIndex}`);

  const min = part.bbox.min;
  const max = part.bbox.max;
  const span: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const across = Math.max(1, options.cellsAcrossThickness ?? DEFAULT_CELLS_ACROSS_THICKNESS);
  const maxCells = Math.max(1, options.maxCells ?? DEFAULT_MAX_CELLS);

  let cellSize = options.cellSize ?? part.thickness / across;
  if (!(cellSize > 0)) return EMPTY_VOLUME(partIndex, 0);

  const diagonal = Math.hypot(span[0], span[1], span[2]);
  const weldTolerance = options.weldTolerance ?? Math.max(diagonal * 1e-6, 1e-12);
  if (!isClosedShell(model, partIndex, weldTolerance)) return EMPTY_VOLUME(partIndex, cellSize);

  // Grow the cell until the grid fits the cap, rather than truncating the box and
  // silently voxelising a corner of the part.
  let coarsened = false;
  for (let guard = 0; guard < 64; guard++) {
    const counts = gridCounts(span, cellSize);
    if (counts[0] * counts[1] * counts[2] <= maxCells) break;
    cellSize *= 1.5;
    coarsened = true;
  }

  const [nx, ny, nz] = gridCounts(span, cellSize);
  const bvh = options.bvh ?? buildBvh(model);
  const ownTriangle = (triangle: number) => model.triPart[triangle] === partIndex;

  // Cell centres sit half a cell inside the bbox corner, so a wall exactly one cell
  // thick still puts a centre in the material rather than on its face.
  const originX = min[0] + cellSize / 2;
  const originY = min[1] + cellSize / 2;
  const originZ = min[2] + cellSize / 2;

  const cellOf = new Int32Array(nx * ny * nz).fill(-1);
  const centres: number[] = [];
  const probe = new Float64Array(3);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        probe[0] = originX + i * cellSize;
        probe[1] = originY + j * cellSize;
        probe[2] = originZ + k * cellSize;
        if (!isInside(bvh, probe, ownTriangle)) continue;
        cellOf[(k * ny + j) * nx + i] = centres.length / 3;
        centres.push(probe[0], probe[1], probe[2]);
      }
    }
  }

  const cellCount = centres.length / 3;
  if (cellCount === 0) return EMPTY_VOLUME(partIndex, cellSize);

  // Neighbours in +X, +Y and +Z only: each shared face is one undirected link.
  const links: number[] = [];
  const boundaryCell: number[] = [];
  const boundaryTriangle: number[] = [];
  const closest = createClosestPointResult();
  const closestOptions: ClosestPointOptions = { accept: ownTriangle };
  const faceCentre = new Float64Array(3);
  const STEPS: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const cell = cellOf[(k * ny + j) * nx + i];
        if (cell < 0) continue;
        for (const [dx, dy, dz] of STEPS) {
          const x = i + dx;
          const y = j + dy;
          const z = k + dz;
          const inGrid = x >= 0 && x < nx && y >= 0 && y < ny && z >= 0 && z < nz;
          const neighbour = inGrid ? cellOf[(z * ny + y) * nx + x] : -1;
          if (neighbour >= 0) {
            // Once per face: only the positive-going half records the link.
            if (dx + dy + dz > 0) links.push(cell, neighbour);
            continue;
          }
          // An exposed face is where this cell meets the world, so it carries the
          // part's area at that spot and links to the surface nearest it.
          faceCentre[0] = centres[cell * 3] + (dx * cellSize) / 2;
          faceCentre[1] = centres[cell * 3 + 1] + (dy * cellSize) / 2;
          faceCentre[2] = centres[cell * 3 + 2] + (dz * cellSize) / 2;
          const found = closestPointInto(
            bvh,
            faceCentre[0],
            faceCentre[1],
            faceCentre[2],
            closest,
            closestOptions,
          );
          if (!found) continue;
          boundaryCell.push(cell);
          boundaryTriangle.push(closest.triangle);
        }
      }
    }
  }

  const centreArray = Float64Array.from(centres);
  return {
    partIndex,
    cellSize,
    cellCount,
    centres: centreArray,
    links: Uint32Array.from(links),
    boundaryCell: Uint32Array.from(boundaryCell),
    boundaryTriangle: Uint32Array.from(boundaryTriangle),
    nodeCell: mapNodesToCells(model, partIndex, centreArray, cellOf, {
      nx,
      ny,
      nz,
      cellSize,
      originX,
      originY,
      originZ,
    }),
    coarsened,
  };
}

interface Grid {
  nx: number;
  ny: number;
  nz: number;
  cellSize: number;
  originX: number;
  originY: number;
  originZ: number;
}

/**
 * Each surface node to the filled cell nearest it.
 *
 * A node sits *on* the boundary, so the cell containing it is as likely to be outside
 * as in; the search therefore widens a ring at a time from the cell it lands in and
 * takes the nearest filled one. Widening is bounded because a node on the surface of a
 * filled body always has material within a cell or two of it — unless the wall is
 * thinner than the grid, in which case that node has no interior to belong to and is
 * left unmapped for the caller to notice.
 */
function mapNodesToCells(
  model: ThermalModel,
  partIndex: number,
  centres: Float64Array,
  cellOf: Int32Array,
  grid: Grid,
): Int32Array {
  const nodeCell = new Int32Array(model.nodeCount).fill(-1);
  const { nx, ny, nz, cellSize, originX, originY, originZ } = grid;

  for (let node = 0; node < model.nodeCount; node++) {
    if (model.nodePart[node] !== partIndex) continue;
    const x = model.nodes[node * 3];
    const y = model.nodes[node * 3 + 1];
    const z = model.nodes[node * 3 + 2];
    const i0 = Math.round((x - originX) / cellSize);
    const j0 = Math.round((y - originY) / cellSize);
    const k0 = Math.round((z - originZ) / cellSize);

    let best = -1;
    let bestDistance = Infinity;
    for (let ring = 0; ring <= 3 && best < 0; ring++) {
      for (let dk = -ring; dk <= ring; dk++) {
        for (let dj = -ring; dj <= ring; dj++) {
          for (let di = -ring; di <= ring; di++) {
            // Only the shell of this ring is new; the inside was searched already.
            if (ring > 0 && Math.max(Math.abs(di), Math.abs(dj), Math.abs(dk)) !== ring) continue;
            const i = i0 + di;
            const j = j0 + dj;
            const k = k0 + dk;
            if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz) continue;
            const cell = cellOf[(k * ny + j) * nx + i];
            if (cell < 0) continue;
            const distance =
              (centres[cell * 3] - x) ** 2 +
              (centres[cell * 3 + 1] - y) ** 2 +
              (centres[cell * 3 + 2] - z) ** 2;
            if (distance >= bestDistance) continue;
            bestDistance = distance;
            best = cell;
          }
        }
      }
    }
    nodeCell[node] = best;
  }
  return nodeCell;
}

function gridCounts(span: readonly number[], cellSize: number): [number, number, number] {
  return [
    Math.max(1, Math.ceil(span[0] / cellSize)),
    Math.max(1, Math.ceil(span[1] / cellSize)),
    Math.max(1, Math.ceil(span[2] / cellSize)),
  ];
}

/** Ray parity against the part's own shell, voted over `PARITY_DIRECTIONS`. */
function isInside(bvh: Bvh, point: Float64Array, accept: (triangle: number) => boolean): boolean {
  const options: RaycastOptions = { minDistance: 0, accept };
  let inside = 0;
  for (const direction of PARITY_DIRECTIONS) {
    if (countRayHits(bvh, point, direction, options) % 2 === 1) inside++;
  }
  return inside >= 2;
}

/**
 * Is every edge of this part shared by exactly two of its triangles?
 *
 * Parity only means anything inside a closed surface. An open shell — a genuine
 * mid-surface sheet, or a part whose tessellation dropped a face — has no inside to
 * find, and filling one would invent a solid the CAD never had. Edges are matched by
 * welded position, because a tessellation numbers each face's corners separately.
 */
function isClosedShell(model: ThermalModel, partIndex: number, tolerance: number): boolean {
  const { clusterOf, clusterCount } = clusterPoints(model.nodes, tolerance);
  const uses = new Map<number, number>();
  let any = false;
  for (let t = 0; t < model.triCount; t++) {
    if (model.triPart[t] !== partIndex) continue;
    any = true;
    for (let e = 0; e < 3; e++) {
      const p = clusterOf[model.tris[t * 3 + e]];
      const q = clusterOf[model.tris[t * 3 + ((e + 1) % 3)]];
      const key = p < q ? p * clusterCount + q : q * clusterCount + p;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  if (!any) return false;
  for (const count of uses.values()) if (count !== 2) return false;
  return true;
}
