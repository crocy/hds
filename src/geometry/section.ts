/**
 * Section plane × model → polylines with interpolated temperatures — spec §7.1.
 *
 * Both bottom-left plots of the reference figure start here: the profile plot is
 * these polylines parameterised by arc length, and the filled 2D field
 * (`analysis/slice2d`) rasterises them.
 *
 * ## Degenerate cases
 *
 * CAD models are full of axis-aligned flat faces and users snap the plane to a
 * principal axis, so a plane that touches the mesh exactly is the normal case, not
 * an exotic one. Vertices within `onPlaneTolerance` of the plane are snapped onto
 * it first, and then:
 *
 * - **Triangle wholly in the plane** — contributes nothing. Its patch boundary is
 *   emitted by the neighbouring triangles that leave the plane, so a plane laid on
 *   a flat face returns that face's outline rather than a filled-in patch.
 * - **Two vertices on the plane** — the shared edge *is* the intersection, so the
 *   edge itself is emitted. Both triangles incident on that edge report it when
 *   neither of them is coplanar, and a duplicate would fork the chain into a
 *   T-junction, so coincident duplicates are collapsed.
 * - **One vertex on the plane, the other two on the same side** — the plane grazes a
 *   single point. A zero-length segment carries no profile, so it is dropped.
 * - **Plane misses the model** — no segments, and an empty array comes back. Not an
 *   error: the user drags the plane past the model all the time.
 */

import type { Bounds, SectionPlane, SectionPolyline, ThermalModel, Vec3 } from '../core/types';
import { buildSpatialHash, forEachPointInRadius, type SpatialHash } from './spatialHash';

/** Fraction of the bbox diagonal at which a vertex counts as lying in the plane. */
export const DEFAULT_ON_PLANE_RATIO = 1e-7;
/** Fraction of the bbox diagonal below which two segment endpoints are the same point. */
export const DEFAULT_CHAIN_TOLERANCE_RATIO = 1e-6;

export interface PlaneBasis {
  origin: Vec3;
  /** Normalised, even when the caller passed a non-unit normal. */
  normal: Vec3;
  axisU: Vec3;
  axisV: Vec3;
  /**
   * Plane coordinates of a point, dropping any out-of-plane component. `point` is
   * a Vec3 or an xyz-interleaved array read at `offset`.
   */
  projectToPlane(point: ArrayLike<number>, offset?: number): [number, number];
}

/**
 * Origin plus two orthonormal in-plane axes, right-handed with the normal
 * (axisU × axisV = normal). The axis choice is deterministic — u follows the world
 * axis least aligned with the normal — so a plane snapped to a principal axis gives
 * the axis-aligned uv the section plots are labelled with.
 */
export function planeBasis(plane: SectionPlane): PlaneBasis {
  const length = Math.hypot(plane.normal[0], plane.normal[1], plane.normal[2]);
  if (!(length > 0)) throw new Error('section plane normal must be non-zero');
  const normal: Vec3 = [
    plane.normal[0] / length,
    plane.normal[1] / length,
    plane.normal[2] / length,
  ];

  let reference = 0;
  for (let k = 1; k < 3; k++) {
    if (Math.abs(normal[k]) < Math.abs(normal[reference])) reference = k;
  }
  const dot = normal[reference];
  const ux = (reference === 0 ? 1 : 0) - dot * normal[0];
  const uy = (reference === 1 ? 1 : 0) - dot * normal[1];
  const uz = (reference === 2 ? 1 : 0) - dot * normal[2];
  const uLength = Math.hypot(ux, uy, uz);
  const axisU: Vec3 = [ux / uLength, uy / uLength, uz / uLength];
  const axisV: Vec3 = [
    normal[1] * axisU[2] - normal[2] * axisU[1],
    normal[2] * axisU[0] - normal[0] * axisU[2],
    normal[0] * axisU[1] - normal[1] * axisU[0],
  ];

  const origin: Vec3 = [plane.origin[0], plane.origin[1], plane.origin[2]];
  return {
    origin,
    normal,
    axisU,
    axisV,
    projectToPlane(point: ArrayLike<number>, offset = 0): [number, number] {
      const dx = point[offset] - origin[0];
      const dy = point[offset + 1] - origin[1];
      const dz = point[offset + 2] - origin[2];
      return [
        dx * axisU[0] + dy * axisU[1] + dz * axisU[2],
        dx * axisV[0] + dy * axisV[1] + dz * axisV[2],
      ];
    },
  };
}

export interface SectionOptions {
  /** Node temperatures, kelvin. Absent → every polyline temperature is NaN. */
  temperature?: ArrayLike<number>;
  /** |signed distance| at or below this counts as lying in the plane. */
  onPlaneTolerance?: number;
  /** Endpoints closer together than this are the same point when chaining. */
  chainTolerance?: number;
}

/**
 * A `SectionPolyline` plus the provenance `slice2d` classifies with.
 *
 * Closed polylines repeat their first point at the end, matching `EdgeChain`, so
 * the last `arcLength` entry is the full perimeter.
 */
export interface SectionPolylineDetail extends SectionPolyline {
  partIndex: number;
  /** 0 = open air, otherwise the cavity id most of this polyline's triangles face. */
  cavityId: number;
}

export function sectionModel(
  model: ThermalModel,
  plane: SectionPlane,
  options: SectionOptions = {},
): SectionPolylineDetail[] {
  const basis = planeBasis(plane);
  const [nx, ny, nz] = basis.normal;
  const [ox, oy, oz] = basis.origin;
  const diagonal = boundsDiagonal(model.bbox);
  const onPlaneTolerance =
    options.onPlaneTolerance ?? Math.max(diagonal * DEFAULT_ON_PLANE_RATIO, 1e-12);
  const chainTolerance =
    options.chainTolerance ?? Math.max(diagonal * DEFAULT_CHAIN_TOLERANCE_RATIO, 1e-12);
  const temperature = options.temperature;
  const { nodes, tris, triCount, triPart, triCavity, nodeCount } = model;

  const distance = new Float64Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) {
    const d =
      (nodes[n * 3] - ox) * nx + (nodes[n * 3 + 1] - oy) * ny + (nodes[n * 3 + 2] - oz) * nz;
    distance[n] = Math.abs(d) <= onPlaneTolerance ? 0 : d;
  }

  const points: number[] = [];
  const temperatures: number[] = [];
  const segmentPart: number[] = [];
  const segmentCavity: number[] = [];
  const nodeTemperature = (node: number) => (temperature ? temperature[node] : NaN);

  const emit = (
    ax: number,
    ay: number,
    az: number,
    at: number,
    bx: number,
    by: number,
    bz: number,
    bt: number,
    part: number,
    cavity: number,
  ) => {
    if (Math.hypot(bx - ax, by - ay, bz - az) <= chainTolerance) return;
    points.push(ax, ay, az, bx, by, bz);
    temperatures.push(at, bt);
    segmentPart.push(part);
    segmentCavity.push(cavity);
  };

  /** Where the plane cuts edge p→q, plus the temperature interpolated along it. */
  const crossing = (p: number, q: number): [number, number, number, number] => {
    const s = distance[p] / (distance[p] - distance[q]);
    return [
      nodes[p * 3] + s * (nodes[q * 3] - nodes[p * 3]),
      nodes[p * 3 + 1] + s * (nodes[q * 3 + 1] - nodes[p * 3 + 1]),
      nodes[p * 3 + 2] + s * (nodes[q * 3 + 2] - nodes[p * 3 + 2]),
      nodeTemperature(p) + s * (nodeTemperature(q) - nodeTemperature(p)),
    ];
  };

  const vertexIndex = [0, 0, 0];
  const vertexDistance = [0, 0, 0];
  for (let t = 0; t < triCount; t++) {
    const i0 = tris[t * 3];
    const i1 = tris[t * 3 + 1];
    const i2 = tris[t * 3 + 2];
    const d0 = distance[i0];
    const d1 = distance[i1];
    const d2 = distance[i2];
    if (d0 > 0 && d1 > 0 && d2 > 0) continue;
    if (d0 < 0 && d1 < 0 && d2 < 0) continue;

    const zeroCount = (d0 === 0 ? 1 : 0) + (d1 === 0 ? 1 : 0) + (d2 === 0 ? 1 : 0);
    if (zeroCount === 3) continue;

    vertexIndex[0] = i0;
    vertexIndex[1] = i1;
    vertexIndex[2] = i2;
    vertexDistance[0] = d0;
    vertexDistance[1] = d1;
    vertexDistance[2] = d2;
    const part = triPart[t];
    const cavity = triCavity[t];

    if (zeroCount === 2) {
      let a = -1;
      let b = -1;
      for (let k = 0; k < 3; k++) {
        if (vertexDistance[k] !== 0) continue;
        if (a < 0) a = vertexIndex[k];
        else b = vertexIndex[k];
      }
      emit(
        nodes[a * 3],
        nodes[a * 3 + 1],
        nodes[a * 3 + 2],
        nodeTemperature(a),
        nodes[b * 3],
        nodes[b * 3 + 1],
        nodes[b * 3 + 2],
        nodeTemperature(b),
        part,
        cavity,
      );
      continue;
    }

    if (zeroCount === 1) {
      let z = 0;
      while (vertexDistance[z] !== 0) z++;
      const p = vertexIndex[(z + 1) % 3];
      const q = vertexIndex[(z + 2) % 3];
      if (vertexDistance[(z + 1) % 3] * vertexDistance[(z + 2) % 3] > 0) continue;
      const far = crossing(p, q);
      const onPlane = vertexIndex[z];
      emit(
        nodes[onPlane * 3],
        nodes[onPlane * 3 + 1],
        nodes[onPlane * 3 + 2],
        nodeTemperature(onPlane),
        far[0],
        far[1],
        far[2],
        far[3],
        part,
        cavity,
      );
      continue;
    }

    let lone = 0;
    for (let k = 0; k < 3; k++) {
      if (vertexDistance[k] * vertexDistance[(k + 1) % 3] < 0) {
        if (vertexDistance[k] * vertexDistance[(k + 2) % 3] < 0) lone = k;
      }
    }
    const a = crossing(vertexIndex[lone], vertexIndex[(lone + 1) % 3]);
    const b = crossing(vertexIndex[lone], vertexIndex[(lone + 2) % 3]);
    emit(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3], part, cavity);
  }

  const segmentCount = segmentPart.length;
  if (segmentCount === 0) return [];

  const endpoints = Float32Array.from(points);
  const endpointTemperature = Float64Array.from(temperatures);
  const hash = buildSpatialHash(endpoints, Math.max(chainTolerance, 1e-12));

  const dropped = dropDuplicateSegments(hash, endpoints, segmentPart, segmentCount, chainTolerance);

  const used = new Uint8Array(segmentCount);
  const near = (endpoint: number, part: number): number => {
    let best = -1;
    let bestDistance = Infinity;
    forEachPointInRadius(
      hash,
      endpoints[endpoint * 3],
      endpoints[endpoint * 3 + 1],
      endpoints[endpoint * 3 + 2],
      chainTolerance,
      (candidate, distanceSquared) => {
        const segment = candidate >> 1;
        if (used[segment] || dropped[segment] || segmentPart[segment] !== part) return;
        if (distanceSquared < bestDistance) {
          bestDistance = distanceSquared;
          best = candidate;
        }
      },
    );
    return best;
  };

  const polylines: SectionPolylineDetail[] = [];
  const forward: number[] = [];
  const backward: number[] = [];
  const chainSegments: number[] = [];
  for (let seed = 0; seed < segmentCount; seed++) {
    if (used[seed] || dropped[seed]) continue;
    const part = segmentPart[seed];
    used[seed] = 1;
    forward.length = 0;
    backward.length = 0;
    chainSegments.length = 0;
    forward.push(seed * 2, seed * 2 + 1);
    chainSegments.push(seed);

    for (;;) {
      const link = near(forward[forward.length - 1], part);
      if (link < 0) break;
      used[link >> 1] = 1;
      chainSegments.push(link >> 1);
      forward.push(link ^ 1);
    }
    for (;;) {
      const link = near(backward.length > 0 ? backward[backward.length - 1] : forward[0], part);
      if (link < 0) break;
      used[link >> 1] = 1;
      chainSegments.push(link >> 1);
      backward.push(link ^ 1);
    }

    const order = backward.reverse().concat(forward);
    polylines.push(
      buildPolyline(
        order,
        chainSegments,
        endpoints,
        endpointTemperature,
        segmentCavity,
        part,
        model.parts[part]?.id ?? `part-${part}`,
        chainTolerance,
      ),
    );
  }
  return polylines;
}

/**
 * A plane lying exactly along a shared edge is reported by both incident triangles.
 * The copies match end for end, so the later one is dropped rather than left to
 * fork the chain.
 */
function dropDuplicateSegments(
  hash: SpatialHash,
  endpoints: Float32Array,
  segmentPart: number[],
  segmentCount: number,
  tolerance: number,
): Uint8Array {
  const dropped = new Uint8Array(segmentCount);
  const toleranceSquared = tolerance * tolerance;
  const apart = (a: number, b: number) => {
    const dx = endpoints[a * 3] - endpoints[b * 3];
    const dy = endpoints[a * 3 + 1] - endpoints[b * 3 + 1];
    const dz = endpoints[a * 3 + 2] - endpoints[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };

  for (let s = 0; s < segmentCount; s++) {
    if (dropped[s]) continue;
    forEachPointInRadius(
      hash,
      endpoints[s * 6],
      endpoints[s * 6 + 1],
      endpoints[s * 6 + 2],
      tolerance,
      (candidate) => {
        const other = candidate >> 1;
        if (other <= s || dropped[other] || segmentPart[other] !== segmentPart[s]) return;
        if (apart(candidate ^ 1, s * 2 + 1) <= toleranceSquared) dropped[other] = 1;
      },
    );
  }
  return dropped;
}

function buildPolyline(
  order: number[],
  chainSegments: number[],
  endpoints: Float32Array,
  endpointTemperature: Float64Array,
  segmentCavity: number[],
  partIndex: number,
  partId: string,
  chainTolerance: number,
): SectionPolylineDetail {
  const count = order.length;
  const points = new Float32Array(count * 3);
  const temperature = new Float32Array(count);
  const arcLength = new Float32Array(count);
  let travelled = 0;
  for (let k = 0; k < count; k++) {
    const endpoint = order[k];
    points[k * 3] = endpoints[endpoint * 3];
    points[k * 3 + 1] = endpoints[endpoint * 3 + 1];
    points[k * 3 + 2] = endpoints[endpoint * 3 + 2];
    temperature[k] = endpointTemperature[endpoint];
    if (k > 0) {
      travelled += Math.hypot(
        points[k * 3] - points[(k - 1) * 3],
        points[k * 3 + 1] - points[(k - 1) * 3 + 1],
        points[k * 3 + 2] - points[(k - 1) * 3 + 2],
      );
    }
    arcLength[k] = travelled;
  }

  // A chain that ran back into its own start already carries the repeated point.
  const first = order[0];
  const last = order[count - 1];
  const closed =
    count >= 4 &&
    Math.hypot(
      endpoints[first * 3] - endpoints[last * 3],
      endpoints[first * 3 + 1] - endpoints[last * 3 + 1],
      endpoints[first * 3 + 2] - endpoints[last * 3 + 2],
    ) <= chainTolerance;

  return {
    partId,
    partIndex,
    cavityId: dominantCavity(chainSegments, segmentCavity),
    points,
    temperature,
    arcLength,
    closed,
  };
}

/**
 * A section polyline is one continuous wall, and the cavity behind it does not
 * change halfway round, so the id most of its segments carry wins.
 */
function dominantCavity(chainSegments: number[], segmentCavity: number[]): number {
  const counts = new Map<number, number>();
  for (const segment of chainSegments) {
    const cavity = segmentCavity[segment];
    counts.set(cavity, (counts.get(cavity) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = -1;
  for (const [cavity, count] of counts) {
    if (count > bestCount || (count === bestCount && cavity < best)) {
      best = cavity;
      bestCount = count;
    }
  }
  return best;
}

function boundsDiagonal(bounds: Bounds): number {
  const diagonal = Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
  return Number.isFinite(diagonal) && diagonal > 0 ? diagonal : 1;
}
