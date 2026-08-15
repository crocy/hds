/**
 * Cavity detection: which triangles face open air, and which face a trapped volume.
 *
 * A closed housing loses far less heat than its raw surface area implies, so the
 * classification here directly sets how much of the model can convect and radiate
 * to ambient at all.
 *
 * ## Scheme
 *
 * From each triangle's centroid, nudged out along its outward normal, we cast a
 * fan of rays into the outward hemisphere and count crossings of the whole
 * assembly. An odd crossing count means the sample point is enclosed by some
 * closed shell; an even count (usually zero) means it can see ambient.
 *
 * Parity alone is fragile: a ray that grazes a shared edge is reported by both
 * adjacent triangles, an open shell gives an arbitrary count depending on where
 * the ray leaves it, and coincident surfaces of touching parts pile hits at the
 * same distance. Two mitigations, in this order:
 *
 * 1. Hits closer together than `mergeDistance` count as one crossing, which folds
 *    a shared-edge double hit back into the single surface crossing it is.
 * 2. `rayCount` rays spread over a cone around the normal each vote, and the
 *    majority wins. One unlucky grazing ray cannot flip a triangle on its own.
 *
 * Inside-facing triangles are then grouped into cavities by flood fill across
 * shared edges. Edges are matched by welded position rather than node index, so
 * this works on an unwelded tessellation and joins triangles across parts that
 * genuinely meet.
 */

import type { Cavity, CavityCondition, ThermalModel } from '../core/types';
import { buildBvh, createHitBuffer, raycastInto, type Bvh, type RaycastOptions } from './bvh';
import { clusterPoints } from './spatialHash';

/** triCavity is a Uint8Array, so 0 is open air and 255 is the highest usable id. */
export const MAX_CAVITY_ID = 255;

export interface CavityConditionDefaults {
  /** Effective film coefficient for surfaces facing the cavity, W/(m²·K). */
  h: number;
  /** Enclosure emissivity — reduced, because the surface radiates to its own walls. */
  emissivity: number;
  /** Conductivity of the fill, for the 2D cut-plane solve. W/(m·K) */
  fillK: number;
}

/**
 * `stillAir` is trapped air: the h is a weak internal-circulation value, fillK is
 * air's conductivity. `insulated` stands in for a foam or wool fill. `adiabatic`
 * shuts the surface off entirely, which is what the user picks to ask "what if
 * this cavity carried no heat at all".
 */
export const CAVITY_DEFAULTS: Record<CavityCondition, CavityConditionDefaults> = {
  stillAir: { h: 5, emissivity: 0.5, fillK: 0.026 },
  insulated: { h: 0.5, emissivity: 0.2, fillK: 0.04 },
  adiabatic: { h: 0, emissivity: 0, fillK: 0 },
};

export interface CavityDetectionOptions {
  /** Rays per triangle. Odd values avoid tied votes. Default 9. */
  rayCount?: number;
  /** Half-angle of the ray fan around the outward normal, radians. Default 60°. */
  coneAngle?: number;
  /** How far off the surface a ray starts, metres. Default 1e-5 × bbox diagonal. */
  offset?: number;
  /** Hits within this distance of each other count as one crossing. Default 1e-7 × diagonal. */
  mergeDistance?: number;
  /** Position tolerance for matching shared edges during flood fill. Default 1e-6 × diagonal. */
  weldTolerance?: number;
  /** Groups smaller than this stay open-air. Default 1 (keep everything). */
  minTriangles?: number;
  /** Condition every detected cavity starts with. Default 'stillAir'. */
  condition?: CavityCondition;
  /** Reuse a BVH already built over this model. */
  bvh?: Bvh;
}

export interface CavityDetectionResult {
  cavities: Cavity[];
  /** The same array as `model.triCavity`, which detection writes in place. */
  triCavity: Uint8Array;
  /** 1 where the triangle's outward side is enclosed, before grouping. */
  insideFacing: Uint8Array;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const DEFAULT_CONE_ANGLE = Math.PI / 3;

export function cavityDefaults(condition: CavityCondition): CavityConditionDefaults {
  return CAVITY_DEFAULTS[condition];
}

export function createCavity(id: number, condition: CavityCondition, name?: string): Cavity {
  const defaults = CAVITY_DEFAULTS[condition];
  return {
    id,
    name: name ?? `cavity ${id}`,
    condition,
    h: defaults.h,
    emissivity: defaults.emissivity,
    fillK: defaults.fillK,
    triCount: 0,
  };
}

/** Switches a cavity's condition and resets h, emissivity and fillK to that condition's defaults. */
export function setCavityCondition(cavity: Cavity, condition: CavityCondition): Cavity {
  const defaults = CAVITY_DEFAULTS[condition];
  cavity.condition = condition;
  cavity.h = defaults.h;
  cavity.emissivity = defaults.emissivity;
  cavity.fillK = defaults.fillK;
  return cavity;
}

export function detectCavities(
  model: ThermalModel,
  options: CavityDetectionOptions = {},
): CavityDetectionResult {
  const diagonal = boundsDiagonal(model);
  const rayCount = Math.max(1, Math.floor(options.rayCount ?? 9));
  const cosCone = Math.cos(options.coneAngle ?? DEFAULT_CONE_ANGLE);
  const offset = options.offset ?? Math.max(diagonal * 1e-5, 1e-9);
  const mergeDistance = options.mergeDistance ?? Math.max(diagonal * 1e-7, 1e-12);
  const weldTolerance = options.weldTolerance ?? Math.max(diagonal * 1e-6, 1e-12);
  const minTriangles = Math.max(1, Math.floor(options.minTriangles ?? 1));
  const condition = options.condition ?? 'stillAir';

  const insideFacing = markInsideFacing(model, {
    bvh: options.bvh ?? buildBvh(model),
    rayCount,
    cosCone,
    offset,
    mergeDistance,
  });

  const groups = groupBySharedEdge(model, insideFacing, weldTolerance);
  const triCavity = model.triCavity;
  triCavity.fill(0);

  const cavities: Cavity[] = [];
  for (const group of groups) {
    if (group.length < minTriangles) continue;
    // Ids past 255 do not fit triCavity; the overflow lands in one shared cavity
    // rather than being silently downgraded to open air.
    const id = Math.min(cavities.length + 1, MAX_CAVITY_ID);
    let cavity = cavities[id - 1];
    if (!cavity) {
      cavity = createCavity(id, condition);
      cavities.push(cavity);
    }
    for (const triangle of group) triCavity[triangle] = id;
    cavity.triCount += group.length;
  }

  return { cavities, triCavity, insideFacing };
}

/** Reclassifies one triangle. `cavityId` 0 means open air. */
export function assignTriangleCavity(
  model: ThermalModel,
  cavities: Cavity[],
  triangle: number,
  cavityId: number,
): void {
  if (triangle < 0 || triangle >= model.triCount) {
    throw new Error(`triangle ${triangle} is outside the model`);
  }
  requireCavity(cavities, cavityId);
  model.triCavity[triangle] = cavityId;
  refreshCavityCounts(model, cavities);
}

/** Reclassifies a whole face region of a part. Returns how many triangles moved. */
export function assignFaceRegionCavity(
  model: ThermalModel,
  cavities: Cavity[],
  partIndex: number,
  faceId: number,
  cavityId: number,
): number {
  requireCavity(cavities, cavityId);
  let changed = 0;
  for (let t = 0; t < model.triCount; t++) {
    if (model.triPart[t] !== partIndex || model.triFace[t] !== faceId) continue;
    if (model.triCavity[t] !== cavityId) changed++;
    model.triCavity[t] = cavityId;
  }
  refreshCavityCounts(model, cavities);
  return changed;
}

/** Recounts every cavity's triCount from triCavity. Cheap enough to run after any edit. */
export function refreshCavityCounts(model: ThermalModel, cavities: Cavity[]): void {
  for (const cavity of cavities) cavity.triCount = 0;
  const byId = new Map(cavities.map((cavity) => [cavity.id, cavity]));
  for (let t = 0; t < model.triCount; t++) {
    const cavity = byId.get(model.triCavity[t]);
    if (cavity) cavity.triCount++;
  }
}

interface FacingParameters {
  bvh: Bvh;
  rayCount: number;
  cosCone: number;
  offset: number;
  mergeDistance: number;
}

function markInsideFacing(model: ThermalModel, parameters: FacingParameters): Uint8Array {
  const { bvh, rayCount, cosCone, offset, mergeDistance } = parameters;
  const { nodes, tris, triNormal, triCount } = model;
  const insideFacing = new Uint8Array(triCount);

  const hits = createHitBuffer(32);
  const rayOptions: RaycastOptions = { minDistance: 0, skipTriangle: -1 };
  const origin = new Float64Array(3);
  const direction = new Float64Array(3);
  const tangentU = new Float64Array(3);
  const tangentV = new Float64Array(3);

  for (let t = 0; t < triCount; t++) {
    const nx = triNormal[t * 3];
    const ny = triNormal[t * 3 + 1];
    const nz = triNormal[t * 3 + 2];
    const a = tris[t * 3] * 3;
    const b = tris[t * 3 + 1] * 3;
    const c = tris[t * 3 + 2] * 3;
    origin[0] = (nodes[a] + nodes[b] + nodes[c]) / 3 + nx * offset;
    origin[1] = (nodes[a + 1] + nodes[b + 1] + nodes[c + 1]) / 3 + ny * offset;
    origin[2] = (nodes[a + 2] + nodes[b + 2] + nodes[c + 2]) / 3 + nz * offset;
    orthonormalBasis(nx, ny, nz, tangentU, tangentV);
    rayOptions.skipTriangle = t;

    let enclosedVotes = 0;
    for (let k = 0; k < rayCount; k++) {
      // Golden-angle fan over the cone; k = 0 is the normal itself.
      const cosTheta = 1 - (k / rayCount) * (1 - cosCone);
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
      const phi = k * GOLDEN_ANGLE;
      const su = Math.cos(phi) * sinTheta;
      const sv = Math.sin(phi) * sinTheta;
      direction[0] = nx * cosTheta + tangentU[0] * su + tangentV[0] * sv;
      direction[1] = ny * cosTheta + tangentU[1] * su + tangentV[1] * sv;
      direction[2] = nz * cosTheta + tangentU[2] * su + tangentV[2] * sv;

      const hitCount = raycastInto(bvh, origin, direction, hits, rayOptions);
      let crossings = 0;
      let previous = -Infinity;
      for (let i = 0; i < hitCount; i++) {
        const distance = hits.distances[i];
        if (distance - previous > mergeDistance) crossings++;
        previous = distance;
      }
      if (crossings % 2 === 1) enclosedVotes++;
    }
    insideFacing[t] = enclosedVotes * 2 > rayCount ? 1 : 0;
  }
  return insideFacing;
}

function groupBySharedEdge(
  model: ThermalModel,
  insideFacing: Uint8Array,
  weldTolerance: number,
): number[][] {
  const { clusterOf, clusterCount } = clusterPoints(model.nodes, weldTolerance);
  const trianglesByEdge = new Map<number, number[]>();
  const edgeKeys = (triangle: number, out: number[]): void => {
    for (let e = 0; e < 3; e++) {
      const p = clusterOf[model.tris[triangle * 3 + e]];
      const q = clusterOf[model.tris[triangle * 3 + ((e + 1) % 3)]];
      out[e] = p < q ? p * clusterCount + q : q * clusterCount + p;
    }
  };

  const keys: number[] = [0, 0, 0];
  for (let t = 0; t < model.triCount; t++) {
    if (!insideFacing[t]) continue;
    edgeKeys(t, keys);
    for (const key of keys) {
      const bucket = trianglesByEdge.get(key);
      if (bucket) bucket.push(t);
      else trianglesByEdge.set(key, [t]);
    }
  }

  const groupOf = new Int32Array(model.triCount).fill(-1);
  const groups: number[][] = [];
  const stack: number[] = [];
  for (let seed = 0; seed < model.triCount; seed++) {
    if (!insideFacing[seed] || groupOf[seed] >= 0) continue;
    const group: number[] = [];
    groupOf[seed] = groups.length;
    stack.push(seed);
    while (stack.length > 0) {
      const triangle = stack.pop() as number;
      group.push(triangle);
      edgeKeys(triangle, keys);
      for (const key of keys) {
        const bucket = trianglesByEdge.get(key);
        if (!bucket) continue;
        for (const neighbour of bucket) {
          if (groupOf[neighbour] >= 0) continue;
          groupOf[neighbour] = groups.length;
          stack.push(neighbour);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

function requireCavity(cavities: Cavity[], cavityId: number): void {
  if (cavityId === 0) return;
  if (cavityId < 0 || cavityId > MAX_CAVITY_ID) {
    throw new Error(`cavity id ${cavityId} is outside 0..${MAX_CAVITY_ID}`);
  }
  if (!cavities.some((cavity) => cavity.id === cavityId)) {
    throw new Error(`no cavity with id ${cavityId}`);
  }
}

/** Duff et al. branchless basis — gives the axis-aligned pair for axis-aligned normals. */
function orthonormalBasis(
  nx: number,
  ny: number,
  nz: number,
  u: Float64Array,
  v: Float64Array,
): void {
  const sign = nz >= 0 ? 1 : -1;
  const a = -1 / (sign + nz);
  const b = nx * ny * a;
  u[0] = 1 + sign * nx * nx * a;
  u[1] = sign * b;
  u[2] = -sign * nx;
  v[0] = b;
  v[1] = sign + ny * ny * a;
  v[2] = -ny;
}

function boundsDiagonal(model: ThermalModel): number {
  const { min, max } = model.bbox;
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return Number.isFinite(diagonal) && diagonal > 0 ? diagonal : 1;
}
