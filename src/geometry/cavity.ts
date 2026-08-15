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
 * same distance. Four mitigations, in this order:
 *
 * 1. Hits closer together than `mergeDistance` count as one crossing, which folds
 *    a shared-edge double hit back into the single surface crossing it is.
 * 2. `rayCount` rays spread over a cone around the normal each vote, and a
 *    supermajority is needed. A triangle where the rays disagree is sitting on
 *    geometry the parity test cannot read, and guessing there is what produced
 *    hundreds of one-triangle cavities on the TBTE assembly.
 * 3. The vote is then cleaned up against mesh adjacency: a triangle that disagrees
 *    with all of its neighbours is noise, and a pinhole of open-air triangles inside
 *    a cavity wall is what splits one real cavity into several.
 * 4. Groups too small to be a volume — by triangle count and by area — stay open air.
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
  /** Rays per triangle. Default 17. */
  rayCount?: number;
  /** Fraction of rays that must agree before a triangle counts as enclosed. Default 2/3. */
  enclosedVoteRatio?: number;
  /** Half-angle of the ray fan around the outward normal, radians. Default 60°. */
  coneAngle?: number;
  /** How far off the surface a ray starts, metres. Default 1e-5 × bbox diagonal. */
  offset?: number;
  /** Hits within this distance of each other count as one crossing. Default 1e-7 × diagonal. */
  mergeDistance?: number;
  /** Position tolerance for matching shared edges during flood fill. Default 1e-6 × diagonal. */
  weldTolerance?: number;
  /** Sweeps of the adjacency cleanup over the raw vote. Default 2; 0 disables it. */
  cleanupPasses?: number;
  /** Groups with fewer triangles than this stay open air unless they meet minArea. Default 4. */
  minTriangles?: number;
  /** Area, m², that keeps a group below minTriangles. Default DEFAULT_MIN_CAVITY_AREA_RATIO × mean triangle area. */
  minArea?: number;
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
const DEFAULT_RAY_COUNT = 17;
/** Two thirds, not a bare majority: a 9-vs-8 split is a coin toss, not a cavity. */
const DEFAULT_ENCLOSED_VOTE_RATIO = 2 / 3;
const DEFAULT_CLEANUP_PASSES = 2;
/** A few facets is the least that can bound a volume; below that it is ray noise. */
const DEFAULT_MIN_TRIANGLES = 4;
/**
 * ...unless the group is large: one facet of a big coarse pocket is a real cavity
 * wall. Measured in mean triangle areas so it follows the mesh, not the units.
 */
export const DEFAULT_MIN_CAVITY_AREA_RATIO = 4;

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
  const rayCount = Math.max(1, Math.floor(options.rayCount ?? DEFAULT_RAY_COUNT));
  const voteRatio = options.enclosedVoteRatio ?? DEFAULT_ENCLOSED_VOTE_RATIO;
  const cosCone = Math.cos(options.coneAngle ?? DEFAULT_CONE_ANGLE);
  const offset = options.offset ?? Math.max(diagonal * 1e-5, 1e-9);
  const mergeDistance = options.mergeDistance ?? Math.max(diagonal * 1e-7, 1e-12);
  const weldTolerance = options.weldTolerance ?? Math.max(diagonal * 1e-6, 1e-12);
  const cleanupPasses = Math.max(0, Math.floor(options.cleanupPasses ?? DEFAULT_CLEANUP_PASSES));
  const minTriangles = Math.max(1, Math.floor(options.minTriangles ?? DEFAULT_MIN_TRIANGLES));
  const minArea = options.minArea ?? meanTriangleArea(model) * DEFAULT_MIN_CAVITY_AREA_RATIO;
  const condition = options.condition ?? 'stillAir';

  const insideFacing = markInsideFacing(model, {
    bvh: options.bvh ?? buildBvh(model),
    rayCount,
    minVotes: Math.max(1, Math.ceil(rayCount * voteRatio)),
    cosCone,
    offset,
    mergeDistance,
  });

  const neighbours = buildTriangleNeighbours(model, weldTolerance);
  cleanUpInsideFacing(insideFacing, neighbours, cleanupPasses);

  const groups = groupByNeighbour(insideFacing, neighbours);
  const triCavity = model.triCavity;
  triCavity.fill(0);

  const kept = groups
    .map((triangles) => ({ triangles, area: groupArea(model, triangles) }))
    .filter((group) => group.triangles.length >= minTriangles || group.area >= minArea);
  // Biggest first, so the ids the user sees rank by significance and the cap below
  // only ever bites the least significant volumes.
  kept.sort((x, y) => y.area - x.area || x.triangles[0] - y.triangles[0]);

  const cavities: Cavity[] = [];
  for (const { triangles: group } of kept) {
    // Ids past 255 do not fit triCavity. Everything past the cap shares the last
    // id rather than wrapping onto another cavity's, and says so in its name.
    const id = Math.min(cavities.length + 1, MAX_CAVITY_ID);
    let cavity = cavities[id - 1];
    if (!cavity) {
      cavity = createCavity(id, condition);
      cavities.push(cavity);
    } else {
      cavity.name = `cavity ${id} (merged overflow)`;
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
  /** Rays that must report an odd crossing count before the triangle counts as enclosed. */
  minVotes: number;
  cosCone: number;
  offset: number;
  mergeDistance: number;
}

function markInsideFacing(model: ThermalModel, parameters: FacingParameters): Uint8Array {
  const { bvh, rayCount, minVotes, cosCone, offset, mergeDistance } = parameters;
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
    insideFacing[t] = enclosedVotes >= minVotes ? 1 : 0;
  }
  return insideFacing;
}

/**
 * Triangles sharing an edge, matched by welded position rather than node index so
 * adjacency survives an unwelded tessellation and crosses parts that genuinely meet.
 * An edge used by more than two triangles links them all — non-manifold seams are
 * normal where parts touch.
 */
interface TriangleNeighbours {
  /** Neighbour indices, `start[t]`..`start[t + 1]` per triangle. */
  neighbour: Int32Array;
  start: Int32Array;
  triCount: number;
}

function buildTriangleNeighbours(model: ThermalModel, weldTolerance: number): TriangleNeighbours {
  const { triCount, tris } = model;
  const { clusterOf, clusterCount } = clusterPoints(model.nodes, weldTolerance);
  const trianglesByEdge = new Map<number, number[]>();
  const keys: number[] = [0, 0, 0];
  const edgeKeys = (triangle: number, out: number[]): void => {
    for (let e = 0; e < 3; e++) {
      const p = clusterOf[tris[triangle * 3 + e]];
      const q = clusterOf[tris[triangle * 3 + ((e + 1) % 3)]];
      out[e] = p < q ? p * clusterCount + q : q * clusterCount + p;
    }
  };

  for (let t = 0; t < triCount; t++) {
    edgeKeys(t, keys);
    for (const key of keys) {
      const bucket = trianglesByEdge.get(key);
      if (bucket) bucket.push(t);
      else trianglesByEdge.set(key, [t]);
    }
  }

  const lists: number[][] = [];
  const start = new Int32Array(triCount + 1);
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    const list: number[] = [];
    edgeKeys(t, keys);
    for (const key of keys) {
      for (const other of trianglesByEdge.get(key) ?? []) {
        if (other !== t && !list.includes(other)) list.push(other);
      }
    }
    lists.push(list);
    total += list.length;
    start[t + 1] = total;
  }

  const neighbour = new Int32Array(total);
  for (let t = 0; t < triCount; t++) neighbour.set(lists[t], start[t]);
  return { neighbour, start, triCount };
}

/**
 * Morphological open-then-close of the raw vote against mesh adjacency.
 *
 * A triangle that no neighbour agrees with is ray noise, and one misclassified
 * facet in a cavity wall splits the cavity in two, so both directions are needed.
 * Bounded passes keep a fill from creeping across an open surface.
 */
function cleanUpInsideFacing(
  insideFacing: Uint8Array,
  neighbours: TriangleNeighbours,
  passes: number,
): void {
  const { neighbour, start, triCount } = neighbours;
  const next = new Uint8Array(triCount);
  for (let pass = 0; pass < passes; pass++) {
    next.set(insideFacing);
    let changed = false;
    for (let t = 0; t < triCount; t++) {
      const from = start[t];
      const to = start[t + 1];
      if (to === from) continue;
      let agreeing = 0;
      for (let i = from; i < to; i++) if (insideFacing[neighbour[i]]) agreeing++;
      const total = to - from;
      if (insideFacing[t] && agreeing === 0) {
        next[t] = 0;
        changed = true;
      } else if (!insideFacing[t] && agreeing >= 2 && agreeing * 2 > total) {
        next[t] = 1;
        changed = true;
      }
    }
    insideFacing.set(next);
    if (!changed) break;
  }
}

/** Flood fill of the inside-facing triangles across shared edges. */
function groupByNeighbour(insideFacing: Uint8Array, neighbours: TriangleNeighbours): number[][] {
  const { neighbour, start, triCount } = neighbours;
  const grouped = new Uint8Array(triCount);
  const groups: number[][] = [];
  const stack: number[] = [];
  for (let seed = 0; seed < triCount; seed++) {
    if (!insideFacing[seed] || grouped[seed]) continue;
    const group: number[] = [];
    grouped[seed] = 1;
    stack.push(seed);
    while (stack.length > 0) {
      const triangle = stack.pop() as number;
      group.push(triangle);
      for (let i = start[triangle]; i < start[triangle + 1]; i++) {
        const other = neighbour[i];
        if (!insideFacing[other] || grouped[other]) continue;
        grouped[other] = 1;
        stack.push(other);
      }
    }
    groups.push(group);
  }
  return groups;
}

function groupArea(model: ThermalModel, group: number[]): number {
  let area = 0;
  for (const triangle of group) area += model.triArea[triangle];
  return area;
}

function meanTriangleArea(model: ThermalModel): number {
  if (model.triCount === 0) return 0;
  let total = 0;
  for (let t = 0; t < model.triCount; t++) total += model.triArea[t];
  return total / model.triCount;
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
