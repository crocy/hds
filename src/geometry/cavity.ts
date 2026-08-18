/**
 * Cavity detection: which triangles face open air, and which face a trapped volume.
 *
 * A closed housing loses far less heat than its raw surface area implies, so the
 * classification here directly sets how much of the model can convect and radiate
 * to ambient at all.
 *
 * ## Scheme
 *
 * The question asked of each triangle is "can this surface see the sky?", not "is
 * this point inside something". From the centroid, nudged out along the outward
 * normal, `rayCount` directions are sampled over the outward hemisphere and the
 * cosine-weighted fraction that escapes the assembly is measured — the view factor
 * to ambient. Below `openSkyThreshold` the triangle is inside-facing.
 *
 * The obvious alternative, ray **parity**, is what this replaced, and it cannot see
 * the case that matters. A CAD sheet-metal part is a closed solid, so the wall of a
 * housing has an inner surface as well as an outer one; a ray fired inward from that
 * inner surface crosses the far wall twice, reads even, and concludes "open air". On
 * the TBTE assembly parity flagged 6 % of the area where occlusion flags 59 % — a
 * sealed housing is roughly half inner skin — and the missing half was convecting to
 * ambient from inside a closed box. What is left, 3136 cm², matches the whole of the
 * reference run's mid-surface mesh (3194 cm²) to 2 %.
 *
 * Occlusion needs no crossing-parity bookkeeping, but the vote and the filtering
 * that made parity usable still earn their place:
 *
 * 1. `rayCount` directions vote, so classification degrades smoothly on geometry that
 *    is genuinely half-open rather than flipping on one unlucky ray.
 * 2. The vote is cleaned up against mesh adjacency: a triangle that disagrees with all
 *    of its neighbours is noise, and a pinhole of open-air triangles inside a cavity
 *    wall is what splits one real cavity into several.
 * 3. Groups too small to be a volume — by triangle count and by area — stay open air.
 *    Without this the assembly produced 77 cavities, most of them one triangle.
 *
 * Inside-facing triangles are then grouped into cavities by flood fill across
 * shared edges. Edges are matched by welded position rather than node index, so
 * this works on an unwelded tessellation and joins triangles across parts that
 * genuinely meet.
 *
 * 4. Groups that can see each other across the void are then merged, because parts
 *    separated by a gap share no edge and the flood fill alone leaves every pocket
 *    walled by a single part — which carries no heat at all. See `mergeGroupsInSight`.
 */

import type { Cavity, CavityCondition, ThermalModel } from '../core/types';
import {
  buildBvh,
  countRayHits,
  createHitBuffer,
  raycastNearestInto,
  type Bvh,
  type RaycastOptions,
} from './bvh';
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
  /** Directions sampled over each triangle's outward hemisphere. Default 32. */
  rayCount?: number;
  /**
   * View factor to ambient below which a triangle counts as enclosed, 0..1.
   * Default DEFAULT_OPEN_SKY_THRESHOLD.
   */
  openSkyThreshold?: number;
  /** How far off the surface a ray starts, metres. Default 1e-5 × bbox diagonal. */
  offset?: number;
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
  /** The measurement behind `insideFacing`: view factor to ambient per triangle, 0..1. */
  openSkyFraction: Float32Array;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const DEFAULT_RAY_COUNT = 32;
/**
 * A surface that reaches ambient over less than a fifth of its hemisphere is in a
 * pocket, whatever the pocket leaks through.
 *
 * Real assemblies measure strongly bimodal: on TBTE, 59 % of the area scores below
 * 0.2, 39 % scores above 0.95, and the 0.2–0.95 band in between is empty, so any
 * threshold in that window classifies identically. The value therefore only decides
 * genuinely half-open geometry — a shallow tray, a wide slot — and 0.2 keeps those
 * open. Note that requiring *zero* escape instead would call the housing's interior
 * open air: it leaks a view factor of 0.05–0.15 through the gaps between parts, and
 * that is still a cavity.
 */
export const DEFAULT_OPEN_SKY_THRESHOLD = 0.2;
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
  const openSkyThreshold = options.openSkyThreshold ?? DEFAULT_OPEN_SKY_THRESHOLD;
  const offset = options.offset ?? Math.max(diagonal * 1e-5, 1e-9);
  const weldTolerance = options.weldTolerance ?? Math.max(diagonal * 1e-6, 1e-12);
  const cleanupPasses = Math.max(0, Math.floor(options.cleanupPasses ?? DEFAULT_CLEANUP_PASSES));
  const minTriangles = Math.max(1, Math.floor(options.minTriangles ?? DEFAULT_MIN_TRIANGLES));
  const minArea = options.minArea ?? meanTriangleArea(model) * DEFAULT_MIN_CAVITY_AREA_RATIO;
  const condition = options.condition ?? 'stillAir';

  const rays: OpenSkyParameters = { bvh: options.bvh ?? buildBvh(model), rayCount, offset };
  const openSkyFraction = measureOpenSky(model, rays);
  const insideFacing = new Uint8Array(model.triCount);
  for (let t = 0; t < model.triCount; t++) {
    insideFacing[t] = openSkyFraction[t] < openSkyThreshold ? 1 : 0;
  }

  const neighbours = buildTriangleNeighbours(model, weldTolerance);
  cleanUpInsideFacing(insideFacing, neighbours, cleanupPasses);

  const groups = mergeGroupsInSight(model, groupByNeighbour(insideFacing, neighbours), rays);
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

  return { cavities, triCavity, insideFacing, openSkyFraction };
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

interface OpenSkyParameters {
  bvh: Bvh;
  rayCount: number;
  offset: number;
}

/**
 * View factor to ambient per triangle: the fraction of a cosine-weighted sample of the
 * outward hemisphere that leaves the assembly without hitting anything.
 *
 * The samples are a golden-angle spiral with `sinθ = √((k + ½)/rayCount)`, which
 * distributes them by projected solid angle. Averaging escape over them with equal
 * weight is therefore already the cosine-weighted average — the same weighting that
 * governs how much radiation and convection this surface can actually exchange with
 * ambient, rather than a raw count of directions.
 */
function measureOpenSky(model: ThermalModel, parameters: OpenSkyParameters): Float32Array {
  const { bvh, rayCount, offset } = parameters;
  const { triCount } = model;
  const openSky = new Float32Array(triCount);

  const rayOptions: RaycastOptions = { minDistance: 0, skipTriangle: -1 };
  const origin = new Float64Array(3);
  const direction = new Float64Array(3);
  const tangentU = new Float64Array(3);
  const tangentV = new Float64Array(3);

  for (let t = 0; t < triCount; t++) {
    fanOrigin(model, t, offset, origin, tangentU, tangentV);
    rayOptions.skipTriangle = t;

    let escaped = 0;
    for (let k = 0; k < rayCount; k++) {
      fanDirection(model, t, k, rayCount, tangentU, tangentV, direction);
      if (countRayHits(bvh, origin, direction, rayOptions) === 0) escaped++;
    }
    openSky[t] = escaped / rayCount;
  }
  return openSky;
}

/** Centroid nudged off the surface, with a basis for the outward hemisphere. */
function fanOrigin(
  model: ThermalModel,
  triangle: number,
  offset: number,
  origin: Float64Array,
  u: Float64Array,
  v: Float64Array,
): void {
  const { nodes, tris, triNormal } = model;
  const nx = triNormal[triangle * 3];
  const ny = triNormal[triangle * 3 + 1];
  const nz = triNormal[triangle * 3 + 2];
  const a = tris[triangle * 3] * 3;
  const b = tris[triangle * 3 + 1] * 3;
  const c = tris[triangle * 3 + 2] * 3;
  origin[0] = (nodes[a] + nodes[b] + nodes[c]) / 3 + nx * offset;
  origin[1] = (nodes[a + 1] + nodes[b + 1] + nodes[c + 1]) / 3 + ny * offset;
  origin[2] = (nodes[a + 2] + nodes[b + 2] + nodes[c + 2]) / 3 + nz * offset;
  orthonormalBasis(nx, ny, nz, u, v);
}

/** The kth ray of the fan. Shared, so the sight-line pass samples what the vote sampled. */
function fanDirection(
  model: ThermalModel,
  triangle: number,
  k: number,
  rayCount: number,
  u: Float64Array,
  v: Float64Array,
  out: Float64Array,
): void {
  const nx = model.triNormal[triangle * 3];
  const ny = model.triNormal[triangle * 3 + 1];
  const nz = model.triNormal[triangle * 3 + 2];
  const sinTheta = Math.sqrt((k + 0.5) / rayCount);
  const cosTheta = Math.sqrt(Math.max(0, 1 - sinTheta * sinTheta));
  const phi = k * GOLDEN_ANGLE;
  const su = Math.cos(phi) * sinTheta;
  const sv = Math.sin(phi) * sinTheta;
  out[0] = nx * cosTheta + u[0] * su + v[0] * sv;
  out[1] = ny * cosTheta + u[1] * su + v[1] * sv;
  out[2] = nz * cosTheta + u[2] * su + v[2] * sv;
}

/**
 * Joins groups that can see each other across the void they bound.
 *
 * Edge adjacency alone gives one group per part: a housing wall and the block floating
 * inside it bound the same trapped air but share no edge, because nothing welds two
 * parts across a gap. That split is not cosmetic. A cavity carries one air temperature,
 * so a pocket walled by a single part equilibrates with that part and then moves no
 * heat at all — the block cannot reach the housing through the air, and a sealed
 * assembly with no metal-to-metal joint solves to zero watts.
 *
 * Two surfaces bound the same volume exactly when a ray from one reaches the other
 * without crossing anything, which is the same condition under which they exchange
 * radiation. Taking the **nearest** hit is what makes that a sight line rather than a
 * guess: a ray stopping at the first surface cannot tunnel through a wall into the
 * pocket beyond, so two sealed shells side by side stay two cavities. Union-find takes
 * the transitive closure, so an L-shaped pocket whose ends cannot see each other still
 * comes out one cavity as long as something sees both.
 */
function mergeGroupsInSight(
  model: ThermalModel,
  groups: number[][],
  parameters: OpenSkyParameters,
): number[][] {
  if (groups.length < 2) return groups;
  const { bvh, rayCount, offset } = parameters;

  const groupOf = new Int32Array(model.triCount).fill(-1);
  groups.forEach((group, index) => {
    for (const triangle of group) groupOf[triangle] = index;
  });

  const parent = new Int32Array(groups.length);
  for (let g = 0; g < groups.length; g++) parent[g] = g;
  const find = (start: number): number => {
    let root = start;
    while (parent[root] !== root) root = parent[root];
    for (let g = start; parent[g] !== root; ) {
      const next = parent[g];
      parent[g] = root;
      g = next;
    }
    return root;
  };
  let roots = groups.length;

  const hits = createHitBuffer(1);
  const rayOptions: RaycastOptions = { minDistance: 0, skipTriangle: -1 };
  const origin = new Float64Array(3);
  const direction = new Float64Array(3);
  const tangentU = new Float64Array(3);
  const tangentV = new Float64Array(3);

  for (let index = 0; index < groups.length && roots > 1; index++) {
    for (const triangle of groups[index]) {
      if (roots === 1) break;
      fanOrigin(model, triangle, offset, origin, tangentU, tangentV);
      rayOptions.skipTriangle = triangle;
      for (let k = 0; k < rayCount; k++) {
        fanDirection(model, triangle, k, rayCount, tangentU, tangentV, direction);
        const hit = raycastNearestInto(bvh, origin, direction, hits, rayOptions);
        if (hit < 0 || groupOf[hit] < 0) continue;
        const a = find(index);
        const b = find(groupOf[hit]);
        if (a === b) continue;
        parent[b] = a;
        roots--;
      }
    }
  }

  const merged = new Map<number, number[]>();
  groups.forEach((group, index) => {
    const root = find(index);
    let bucket = merged.get(root);
    if (!bucket) {
      bucket = [];
      merged.set(root, bucket);
    }
    for (const triangle of group) bucket.push(triangle);
  });
  return [...merged.values()];
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
