/**
 * A compact bounding-volume hierarchy over the assembly's triangle soup.
 *
 * Cavity detection fires a dozen rays per triangle over the whole model, so the
 * layout is chosen for that: nodes live in three flat typed arrays, triangle
 * vertices are copied into a leaf-ordered buffer, and a query allocates nothing
 * unless the caller asks for hit objects back.
 *
 * Two query families live here: rays (cavity parity counting) and closest point
 * on the mesh (contact detection, which cannot assume the two parts' meshes share
 * vertices and so has to measure a node against whole triangles).
 */

import type { ThermalModel } from '../core/types';

export interface BvhOptions {
  /** Triangles per leaf. Larger trades traversal steps for triangle tests. */
  maxLeafSize?: number;
}

export interface Bvh {
  /** Original triangle indices, permuted so every leaf owns a contiguous run. */
  triIndex: Uint32Array;
  /** minXYZ then maxXYZ per node. */
  bounds: Float32Array;
  /** Leaf: first entry in triIndex. Internal: right child index (the left child is node + 1). */
  offset: Int32Array;
  /** Triangles in this leaf; 0 marks an internal node. */
  leafSize: Int32Array;
  nodeCount: number;
  triCount: number;
  /** Triangle vertices in triIndex order, 9 floats each. */
  triVerts: Float32Array;
  /** Traversal scratch. Queries are single-threaded and never nest, so one is enough. */
  stack: Int32Array;
  /** Squared box distance per `stack` entry, for the nearest-box-first closest-point descent. */
  stackDistance: Float64Array;
  /** Closest-point-on-triangle scratch, xyz. */
  pointScratch: Float64Array;
}

export interface RaycastOptions {
  /** Ignore hits closer than this along the ray. Default 0. */
  minDistance?: number;
  /** Ignore hits beyond this along the ray. Default Infinity. */
  maxDistance?: number;
  /** Original triangle index to ignore — normally the face the ray was cast from. */
  skipTriangle?: number;
}

export interface BvhHit {
  /** Index into ThermalModel.tris / triArea / triNormal. */
  triangle: number;
  /** Distance along the ray direction as supplied (metres when the direction is unit length). */
  distance: number;
}

export interface ClosestPointOptions {
  /** Ignore triangles further than this from the query point, metres. Default Infinity. */
  maxDistance?: number;
  /** Original triangle index to ignore. */
  skipTriangle?: number;
  /**
   * Rejects triangles by original index — contact detection uses it to skip the
   * querying node's own part and anything not facing it. Must not itself query
   * this BVH: the traversal stack is shared.
   */
  accept?: (triangle: number) => boolean;
}

/** Reusable closest-point result, so a query in a hot loop allocates nothing. */
export interface ClosestPointResult {
  /** Index into ThermalModel.tris, or -1 when nothing qualified. */
  triangle: number;
  /** Distance from the query point to `x, y, z`, metres. Infinity when nothing qualified. */
  distance: number;
  /** The closest point itself, on the matched triangle. */
  x: number;
  y: number;
  z: number;
}

export function createClosestPointResult(): ClosestPointResult {
  return { triangle: -1, distance: Infinity, x: 0, y: 0, z: 0 };
}

/** Growable hit sink, so a ray query in a hot loop allocates nothing. */
export interface HitBuffer {
  distances: Float64Array;
  triangles: Int32Array;
  count: number;
}

const DET_EPSILON = 1e-14;
/** Barycentric slack, so a ray through a shared edge hits both triangles rather than neither. */
const EDGE_EPSILON = 1e-9;

export function createHitBuffer(capacity = 16): HitBuffer {
  return {
    distances: new Float64Array(Math.max(1, capacity)),
    triangles: new Int32Array(Math.max(1, capacity)),
    count: 0,
  };
}

export function buildBvh(model: ThermalModel, options: BvhOptions = {}): Bvh {
  const maxLeafSize = Math.max(1, options.maxLeafSize ?? 4);
  const triCount = model.triCount;
  const { nodes, tris } = model;

  const centroids = new Float64Array(triCount * 3);
  const triMin = new Float64Array(triCount * 3);
  const triMax = new Float64Array(triCount * 3);
  let rootExtent: number;
  {
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < triCount; t++) {
      for (let axis = 0; axis < 3; axis++) {
        const a = nodes[tris[t * 3] * 3 + axis];
        const b = nodes[tris[t * 3 + 1] * 3 + axis];
        const c = nodes[tris[t * 3 + 2] * 3 + axis];
        const min = Math.min(a, b, c);
        const max = Math.max(a, b, c);
        triMin[t * 3 + axis] = min;
        triMax[t * 3 + axis] = max;
        centroids[t * 3 + axis] = (a + b + c) / 3;
        if (min < lo) lo = min;
        if (max > hi) hi = max;
      }
    }
    rootExtent = hi > lo ? hi - lo : 0;
  }

  // Float32 node bounds round in both directions; pad so a rounded-in face can't
  // hide a triangle that really does straddle it.
  const pad = Math.max(rootExtent * 1e-6, 1e-9);

  const order = new Uint32Array(triCount);
  for (let i = 0; i < triCount; i++) order[i] = i;

  const maxNodes = Math.max(1, 2 * triCount);
  const bounds = new Float32Array(maxNodes * 6);
  const offset = new Int32Array(maxNodes);
  const leafSize = new Int32Array(maxNodes);
  let nodeCount = 0;
  let maxDepth = 1;

  const buildRange = (start: number, end: number, depth: number): number => {
    const node = nodeCount++;
    if (depth > maxDepth) maxDepth = depth;

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = start; i < end; i++) {
      const t = order[i] * 3;
      if (triMin[t] < minX) minX = triMin[t];
      if (triMin[t + 1] < minY) minY = triMin[t + 1];
      if (triMin[t + 2] < minZ) minZ = triMin[t + 2];
      if (triMax[t] > maxX) maxX = triMax[t];
      if (triMax[t + 1] > maxY) maxY = triMax[t + 1];
      if (triMax[t + 2] > maxZ) maxZ = triMax[t + 2];
    }
    const b = node * 6;
    bounds[b] = minX - pad;
    bounds[b + 1] = minY - pad;
    bounds[b + 2] = minZ - pad;
    bounds[b + 3] = maxX + pad;
    bounds[b + 4] = maxY + pad;
    bounds[b + 5] = maxZ + pad;

    if (end - start <= maxLeafSize) {
      offset[node] = start;
      leafSize[node] = end - start;
      return node;
    }

    let axis = 0;
    let widest = maxX - minX;
    if (maxY - minY > widest) {
      widest = maxY - minY;
      axis = 1;
    }
    if (maxZ - minZ > widest) axis = 2;

    // Median split: balanced by construction, so traversal depth stays log2(n)
    // whatever the geometry looks like.
    const mid = (start + end) >> 1;
    selectNthByCentroid(order, centroids, start, end, mid, axis);
    leafSize[node] = 0;
    buildRange(start, mid, depth + 1);
    offset[node] = buildRange(mid, end, depth + 1);
    return node;
  };

  if (triCount > 0) {
    buildRange(0, triCount, 1);
  } else {
    // One node whose inverted bounds every ray misses.
    nodeCount = 1;
    bounds.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], 0);
    leafSize[0] = 0;
    offset[0] = 0;
  }

  const triVerts = new Float32Array(triCount * 9);
  for (let i = 0; i < triCount; i++) {
    const t = order[i];
    for (let k = 0; k < 3; k++) {
      const n = tris[t * 3 + k] * 3;
      triVerts[i * 9 + k * 3] = nodes[n];
      triVerts[i * 9 + k * 3 + 1] = nodes[n + 1];
      triVerts[i * 9 + k * 3 + 2] = nodes[n + 2];
    }
  }

  return {
    triIndex: order,
    bounds: bounds.slice(0, nodeCount * 6),
    offset: offset.slice(0, nodeCount),
    leafSize: leafSize.slice(0, nodeCount),
    nodeCount,
    triCount,
    triVerts,
    stack: new Int32Array(2 * maxDepth + 8),
    stackDistance: new Float64Array(2 * maxDepth + 8),
    pointScratch: new Float64Array(3),
  };
}

/**
 * All hits along the ray, written into `buffer` sorted by distance.
 * Returns the hit count; the buffer's arrays may be reallocated to fit.
 */
export function raycastInto(
  bvh: Bvh,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  buffer: HitBuffer,
  options: RaycastOptions = {},
): number {
  buffer.count = 0;
  const count = traverseRay(bvh, origin, direction, options, buffer, false);
  sortHits(buffer);
  return count;
}

/** All hits along the ray, nearest first. */
export function raycastAll(
  bvh: Bvh,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  options: RaycastOptions = {},
): BvhHit[] {
  const buffer = createHitBuffer();
  const count = raycastInto(bvh, origin, direction, buffer, options);
  const hits: BvhHit[] = [];
  for (let i = 0; i < count; i++) {
    hits.push({ triangle: buffer.triangles[i], distance: buffer.distances[i] });
  }
  return hits;
}

/** The closest hit along the ray, or null. */
export function raycastNearest(
  bvh: Bvh,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  options: RaycastOptions = {},
): BvhHit | null {
  const buffer = createHitBuffer(1);
  const count = traverseRay(bvh, origin, direction, options, buffer, true);
  if (count === 0) return null;
  return { triangle: buffer.triangles[0], distance: buffer.distances[0] };
}

/**
 * The closest hit, into a caller-owned buffer. Returns the triangle index, or −1.
 * The allocation-free form of `raycastNearest`, for a fan of rays per triangle.
 */
export function raycastNearestInto(
  bvh: Bvh,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  buffer: HitBuffer,
  options: RaycastOptions = {},
): number {
  buffer.count = 0;
  return traverseRay(bvh, origin, direction, options, buffer, true) === 0
    ? -1
    : buffer.triangles[0];
}

/** Hit count only — no hit records, no allocation. */
export function countRayHits(
  bvh: Bvh,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  options: RaycastOptions = {},
): number {
  return traverseRay(bvh, origin, direction, options, null, false);
}

function traverseRay(
  bvh: Bvh,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  options: RaycastOptions,
  buffer: HitBuffer | null,
  nearestOnly: boolean,
): number {
  if (bvh.triCount === 0) return 0;

  const ox = origin[0];
  const oy = origin[1];
  const oz = origin[2];
  const dx = direction[0];
  const dy = direction[1];
  const dz = direction[2];
  // A zero component would make (bound - origin) * Infinity produce NaN on the
  // slab whose plane the origin sits exactly on; a tiny non-zero keeps it finite.
  const invX = 1 / (dx === 0 ? 1e-30 : dx);
  const invY = 1 / (dy === 0 ? 1e-30 : dy);
  const invZ = 1 / (dz === 0 ? 1e-30 : dz);

  const minDistance = options.minDistance ?? 0;
  const skipTriangle = options.skipTriangle ?? -1;
  let maxDistance = options.maxDistance ?? Infinity;

  const { bounds, offset, leafSize, triIndex, triVerts, stack } = bvh;
  let sp = 0;
  stack[sp++] = 0;
  let hits = 0;

  while (sp > 0) {
    const node = stack[--sp];
    const b = node * 6;

    let t0 = (bounds[b] - ox) * invX;
    let t1 = (bounds[b + 3] - ox) * invX;
    let enter = t0 < t1 ? t0 : t1;
    let exit = t0 < t1 ? t1 : t0;
    t0 = (bounds[b + 1] - oy) * invY;
    t1 = (bounds[b + 4] - oy) * invY;
    enter = Math.max(enter, t0 < t1 ? t0 : t1);
    exit = Math.min(exit, t0 < t1 ? t1 : t0);
    t0 = (bounds[b + 2] - oz) * invZ;
    t1 = (bounds[b + 5] - oz) * invZ;
    enter = Math.max(enter, t0 < t1 ? t0 : t1);
    exit = Math.min(exit, t0 < t1 ? t1 : t0);
    if (!(exit >= enter) || exit < minDistance || enter > maxDistance) continue;

    const size = leafSize[node];
    if (size === 0) {
      stack[sp++] = offset[node];
      stack[sp++] = node + 1;
      continue;
    }

    const start = offset[node];
    for (let k = 0; k < size; k++) {
      const local = start + k;
      const triangle = triIndex[local];
      if (triangle === skipTriangle) continue;
      const distance = intersectTriangle(triVerts, local * 9, ox, oy, oz, dx, dy, dz);
      if (!(distance >= minDistance) || distance > maxDistance) continue;
      if (nearestOnly) {
        maxDistance = distance;
        hits = 1;
        if (buffer) {
          buffer.distances[0] = distance;
          buffer.triangles[0] = triangle;
          buffer.count = 1;
        }
      } else {
        hits++;
        if (buffer) pushHit(buffer, distance, triangle);
      }
    }
  }
  return hits;
}

/**
 * Nearest point of the mesh to (x, y, z), written into `out`.
 *
 * Descends nearest box first and prunes every box further away than the best
 * triangle found so far, so a bounded query (`maxDistance`) touches only the
 * handful of leaves around the point.
 *
 * Returns true when a triangle qualified.
 */
export function closestPointInto(
  bvh: Bvh,
  x: number,
  y: number,
  z: number,
  out: ClosestPointResult,
  options: ClosestPointOptions = {},
): boolean {
  out.triangle = -1;
  out.distance = Infinity;
  if (bvh.triCount === 0) return false;

  const skipTriangle = options.skipTriangle ?? -1;
  const accept = options.accept;
  const maxDistance = options.maxDistance ?? Infinity;
  let bestSquared = maxDistance * maxDistance;

  const { bounds, offset, leafSize, triIndex, triVerts, stack, stackDistance, pointScratch } = bvh;
  let sp = 0;
  const rootDistance = boxDistanceSquared(bounds, 0, x, y, z);
  if (rootDistance > bestSquared) return false;
  stack[sp] = 0;
  stackDistance[sp] = rootDistance;
  sp++;

  while (sp > 0) {
    sp--;
    // The bound tightened after this box was pushed; whatever is inside it is out of reach.
    if (stackDistance[sp] > bestSquared) continue;
    const node = stack[sp];

    const size = leafSize[node];
    if (size === 0) {
      const left = node + 1;
      const right = offset[node];
      const leftDistance = boxDistanceSquared(bounds, left, x, y, z);
      const rightDistance = boxDistanceSquared(bounds, right, x, y, z);
      // Farther child first, so the nearer one pops next and tightens the bound for it.
      const firstNode = leftDistance <= rightDistance ? right : left;
      const firstDistance = leftDistance <= rightDistance ? rightDistance : leftDistance;
      const secondNode = leftDistance <= rightDistance ? left : right;
      const secondDistance = leftDistance <= rightDistance ? leftDistance : rightDistance;
      if (firstDistance <= bestSquared) {
        stack[sp] = firstNode;
        stackDistance[sp] = firstDistance;
        sp++;
      }
      if (secondDistance <= bestSquared) {
        stack[sp] = secondNode;
        stackDistance[sp] = secondDistance;
        sp++;
      }
      continue;
    }

    const start = offset[node];
    for (let k = 0; k < size; k++) {
      const local = start + k;
      const triangle = triIndex[local];
      if (triangle === skipTriangle) continue;
      if (accept && !accept(triangle)) continue;
      closestPointOnTriangle(triVerts, local * 9, x, y, z, pointScratch);
      const dx = pointScratch[0] - x;
      const dy = pointScratch[1] - y;
      const dz = pointScratch[2] - z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (distanceSquared > bestSquared) continue;
      bestSquared = distanceSquared;
      out.triangle = triangle;
      out.x = pointScratch[0];
      out.y = pointScratch[1];
      out.z = pointScratch[2];
    }
  }

  if (out.triangle < 0) return false;
  out.distance = Math.sqrt(bestSquared);
  return true;
}

/** Allocating form of `closestPointInto`, for callers outside a hot loop. */
export function closestPointOnMesh(
  bvh: Bvh,
  x: number,
  y: number,
  z: number,
  options: ClosestPointOptions = {},
): ClosestPointResult | null {
  const out = createClosestPointResult();
  return closestPointInto(bvh, x, y, z, out, options) ? out : null;
}

/**
 * Closest point of one triangle to (x, y, z), written into `out` — Ericson's
 * Voronoi-region test (Real-Time Collision Detection §5.1.5).
 *
 * The regions are the point of it: distance to the triangle's plane is only the
 * answer when the projection lands inside the triangle, and two mating CAD faces
 * meet edge-on often enough that the vertex and edge regions decide real contacts.
 */
export function closestPointOnTriangle(
  verts: ArrayLike<number>,
  at: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): void {
  const ax = verts[at];
  const ay = verts[at + 1];
  const az = verts[at + 2];
  const bx = verts[at + 3];
  const by = verts[at + 4];
  const bz = verts[at + 5];
  const cx = verts[at + 6];
  const cy = verts[at + 7];
  const cz = verts[at + 8];

  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;

  const apx = x - ax;
  const apy = y - ay;
  const apz = z - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return writePoint(out, ax, ay, az);

  const bpx = x - bx;
  const bpy = y - by;
  const bpz = z - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return writePoint(out, bx, by, bz);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return writePoint(out, ax + abx * v, ay + aby * v, az + abz * v);
  }

  const cpx = x - cx;
  const cpy = y - cy;
  const cpz = z - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return writePoint(out, cx, cy, cz);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return writePoint(out, ax + acx * w, ay + acy * w, az + acz * w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return writePoint(out, bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w);
  }

  const denom = va + vb + vc;
  // A degenerate (zero-area) triangle has no interior; the region tests above
  // already covered its extent, so fall back to a vertex rather than divide by 0.
  if (!(denom > 0)) return writePoint(out, ax, ay, az);
  const v = vb / denom;
  const w = vc / denom;
  writePoint(out, ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

function writePoint(out: Float64Array, x: number, y: number, z: number): void {
  out[0] = x;
  out[1] = y;
  out[2] = z;
}

/** Squared distance from a point to a node's box; 0 when the point is inside it. */
function boxDistanceSquared(
  bounds: Float32Array,
  node: number,
  x: number,
  y: number,
  z: number,
): number {
  const b = node * 6;
  const dx = Math.max(bounds[b] - x, 0, x - bounds[b + 3]);
  const dy = Math.max(bounds[b + 1] - y, 0, y - bounds[b + 4]);
  const dz = Math.max(bounds[b + 2] - z, 0, z - bounds[b + 5]);
  return dx * dx + dy * dy + dz * dz;
}

/** Möller–Trumbore, two-sided. Returns the ray parameter, or NaN when it misses. */
function intersectTriangle(
  verts: Float32Array,
  at: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const ax = verts[at];
  const ay = verts[at + 1];
  const az = verts[at + 2];
  const e1x = verts[at + 3] - ax;
  const e1y = verts[at + 4] - ay;
  const e1z = verts[at + 5] - az;
  const e2x = verts[at + 6] - ax;
  const e2y = verts[at + 7] - ay;
  const e2z = verts[at + 8] - az;

  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -DET_EPSILON && det < DET_EPSILON) return NaN;

  const invDet = 1 / det;
  const tx = ox - ax;
  const ty = oy - ay;
  const tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < -EDGE_EPSILON || u > 1 + EDGE_EPSILON) return NaN;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < -EDGE_EPSILON || u + v > 1 + EDGE_EPSILON) return NaN;

  return (e2x * qx + e2y * qy + e2z * qz) * invDet;
}

function pushHit(buffer: HitBuffer, distance: number, triangle: number): void {
  if (buffer.count === buffer.distances.length) {
    const distances = new Float64Array(buffer.count * 2);
    distances.set(buffer.distances);
    buffer.distances = distances;
    const triangles = new Int32Array(buffer.count * 2);
    triangles.set(buffer.triangles);
    buffer.triangles = triangles;
  }
  buffer.distances[buffer.count] = distance;
  buffer.triangles[buffer.count] = triangle;
  buffer.count++;
}

/** Insertion sort: hit counts per ray are tiny, and it keeps the query allocation-free. */
function sortHits(buffer: HitBuffer): void {
  const { distances, triangles } = buffer;
  for (let i = 1; i < buffer.count; i++) {
    const distance = distances[i];
    const triangle = triangles[i];
    let j = i - 1;
    while (j >= 0 && distances[j] > distance) {
      distances[j + 1] = distances[j];
      triangles[j + 1] = triangles[j];
      j--;
    }
    distances[j + 1] = distance;
    triangles[j + 1] = triangle;
  }
}

/** Quickselect: partially orders `index` so entry `nth` is the one a full sort would put there. */
function selectNthByCentroid(
  index: Uint32Array,
  centroids: Float64Array,
  start: number,
  end: number,
  nth: number,
  axis: number,
): void {
  let lo = start;
  let hi = end - 1;
  while (lo < hi) {
    const pivot = centroids[index[(lo + hi) >> 1] * 3 + axis];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (centroids[index[i] * 3 + axis] < pivot) i++;
      while (centroids[index[j] * 3 + axis] > pivot) j--;
      if (i <= j) {
        const swap = index[i];
        index[i] = index[j];
        index[j] = swap;
        i++;
        j--;
      }
    }
    if (nth <= j) hi = j;
    else if (nth >= i) lo = i;
    else return;
  }
}
