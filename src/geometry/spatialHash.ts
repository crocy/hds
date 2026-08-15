/**
 * Uniform-grid spatial hash over points, with a radius query.
 *
 * Buckets are a counting sort into flat typed arrays rather than a Map of arrays:
 * contact detection walks every node in the assembly through this.
 */

export interface SpatialHashOptions {
  /** Points to index, as indices into `points`. Defaults to every point. */
  indices?: ArrayLike<number>;
}

export interface SpatialHash {
  /** xyz interleaved. Held by reference — the caller must not move points afterwards. */
  points: Float32Array;
  cellSize: number;
  invCellSize: number;
  /** Prefix sums into `items`, length tableSize + 1. */
  bucketStart: Uint32Array;
  /** Point indices grouped by bucket. */
  items: Uint32Array;
  tableSize: number;
  /** Per-bucket stamp, so a query that spans colliding cells visits each bucket once. */
  visited: Int32Array;
  visitStamp: number;
  pointCount: number;
}

export type PointVisitor = (index: number, distanceSquared: number) => void;

export function buildSpatialHash(
  points: Float32Array,
  cellSize: number,
  options: SpatialHashOptions = {},
): SpatialHash {
  if (!(cellSize > 0)) throw new Error(`spatial hash cellSize must be positive, got ${cellSize}`);

  const indices = options.indices;
  const pointCount = indices ? indices.length : points.length / 3;
  const tableSize = nextPowerOfTwo(Math.max(16, pointCount * 2));
  const mask = tableSize - 1;
  const invCellSize = 1 / cellSize;

  const counts = new Uint32Array(tableSize + 1);
  const bucketOf = new Uint32Array(pointCount);
  for (let i = 0; i < pointCount; i++) {
    const p = (indices ? indices[i] : i) * 3;
    const bucket =
      hashCell(
        Math.floor(points[p] * invCellSize),
        Math.floor(points[p + 1] * invCellSize),
        Math.floor(points[p + 2] * invCellSize),
      ) & mask;
    bucketOf[i] = bucket;
    counts[bucket + 1]++;
  }
  for (let b = 0; b < tableSize; b++) counts[b + 1] += counts[b];

  const cursor = counts.slice(0, tableSize);
  const items = new Uint32Array(pointCount);
  for (let i = 0; i < pointCount; i++) {
    items[cursor[bucketOf[i]]++] = indices ? indices[i] : i;
  }

  return {
    points,
    cellSize,
    invCellSize,
    bucketStart: counts,
    items,
    tableSize,
    visited: new Int32Array(tableSize).fill(-1),
    visitStamp: 0,
    pointCount,
  };
}

/** Calls `visit` for every indexed point within `radius` of (x, y, z). Allocates nothing. */
export function forEachPointInRadius(
  hash: SpatialHash,
  x: number,
  y: number,
  z: number,
  radius: number,
  visit: PointVisitor,
): void {
  const { points, invCellSize, bucketStart, items, visited } = hash;
  const mask = hash.tableSize - 1;
  const radiusSquared = radius * radius;
  const stamp = hash.visitStamp++;

  const minX = Math.floor((x - radius) * invCellSize);
  const minY = Math.floor((y - radius) * invCellSize);
  const minZ = Math.floor((z - radius) * invCellSize);
  const maxX = Math.floor((x + radius) * invCellSize);
  const maxY = Math.floor((y + radius) * invCellSize);
  const maxZ = Math.floor((z + radius) * invCellSize);

  for (let cz = minZ; cz <= maxZ; cz++) {
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const bucket = hashCell(cx, cy, cz) & mask;
        if (visited[bucket] === stamp) continue;
        visited[bucket] = stamp;
        for (let s = bucketStart[bucket]; s < bucketStart[bucket + 1]; s++) {
          const index = items[s];
          const p = index * 3;
          const dx = points[p] - x;
          const dy = points[p + 1] - y;
          const dz = points[p + 2] - z;
          const distanceSquared = dx * dx + dy * dy + dz * dz;
          if (distanceSquared <= radiusSquared) visit(index, distanceSquared);
        }
      }
    }
  }
}

export function queryRadius(
  hash: SpatialHash,
  x: number,
  y: number,
  z: number,
  radius: number,
  out: number[] = [],
): number[] {
  out.length = 0;
  forEachPointInRadius(hash, x, y, z, radius, (index) => {
    out.push(index);
  });
  return out;
}

/** Index of the closest indexed point within `radius`, or -1. */
export function nearestPoint(
  hash: SpatialHash,
  x: number,
  y: number,
  z: number,
  radius: number,
): number {
  let best = -1;
  let bestDistanceSquared = Infinity;
  forEachPointInRadius(hash, x, y, z, radius, (index, distanceSquared) => {
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      best = index;
    }
  });
  return best;
}

export interface PointClusters {
  /** Cluster id per point, indexed like `points`. -1 for points that were not indexed. */
  clusterOf: Int32Array;
  clusterCount: number;
}

/**
 * Groups points that sit within `tolerance` of each other.
 *
 * Greedy single pass, not transitive: a chain of points each within tolerance of
 * the next does NOT collapse into one cluster. That is what we want for welding
 * coincident mesh vertices, where the tolerance is far below the mesh spacing.
 * This is a local adjacency helper — `geometry/build` owns the import-time weld.
 */
export function clusterPoints(
  points: Float32Array,
  tolerance: number,
  options: SpatialHashOptions = {},
): PointClusters {
  const pointCount = points.length / 3;
  const clusterOf = new Int32Array(pointCount).fill(-1);
  if (pointCount === 0) return { clusterOf, clusterCount: 0 };

  const hash = buildSpatialHash(points, Math.max(tolerance, 1e-12), options);
  const indices = options.indices;
  const indexedCount = indices ? indices.length : pointCount;
  let clusterCount = 0;

  for (let i = 0; i < indexedCount; i++) {
    const seed = indices ? indices[i] : i;
    if (clusterOf[seed] >= 0) continue;
    const cluster = clusterCount++;
    clusterOf[seed] = cluster;
    const p = seed * 3;
    forEachPointInRadius(hash, points[p], points[p + 1], points[p + 2], tolerance, (index) => {
      if (clusterOf[index] < 0) clusterOf[index] = cluster;
    });
  }
  return { clusterOf, clusterCount };
}

function hashCell(x: number, y: number, z: number): number {
  return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
}

function nextPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}
