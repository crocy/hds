/**
 * Contact detection: where do parts on different bodies actually touch?
 *
 * Nodes are deliberately not welded across parts, so every path for heat between
 * two parts runs through a Contact and can carry a finite conductance. A bolted
 * joint, a welded seam and two parts that merely rest against each other are the
 * same geometry and different physics.
 *
 * ## Why node-to-triangle
 *
 * CAD assemblies are non-conformal: two mating faces are tessellated independently,
 * so their vertices do not coincide even where the surfaces are flush. Pairing node
 * to node only finds joints by accident — on the TBTE housing it saw one of the nine
 * pairs that actually touch. Every node is therefore measured against whole triangles
 * of the other parts, and linked to the nearest vertex of the triangle it lands on so
 * `Contact.nodePairs` still describes node-to-node conductances.
 */

import { PERFECT_CONTACT, type Contact, type ThermalModel, type Vec3 } from '../core/types';
import {
  buildBvh,
  closestPointInto,
  createClosestPointResult,
  type Bvh,
  type ClosestPointOptions,
} from './bvh';
import {
  buildSpatialHash,
  forEachPointInRadius,
  nearestPoint,
  type SpatialHash,
} from './spatialHash';

/**
 * 0.5 mm, in metres. Node-to-triangle measures the real surface gap, so the bound
 * has to cover CAD clearance plus tessellation chord error rather than the vertex
 * coincidence slop the old node-to-node 0.2 mm was tuned for.
 */
export const DEFAULT_CONTACT_TOLERANCE = 5e-4;

/** One touching vertex is a mesh coincidence, not a joint. Two is the smallest real edge contact. */
export const DEFAULT_MIN_PAIRS = 2;

/**
 * ...unless that one vertex carries real area. On a coarse lump a whole mating face
 * can reduce to a single node, so a patch also survives when its area reaches this
 * multiple of the model's mean node tributary area. Relative, so it tracks the mesh
 * rather than the model's size.
 */
export const DEFAULT_MIN_PATCH_AREA_RATIO = 1;

/**
 * Surfaces that touch face each other, so the matched triangle's normal must oppose
 * the node's. -0.5 admits anything within 60° of anti-parallel, which covers a node
 * sitting on a rounded corner or a chamfer, and still refuses to bond two parts that
 * merely run alongside one another or to reach through a thin wall.
 *
 * A zero-thickness idealisation of a butt joint — two coplanar shells meeting edge to
 * edge, normals side by side — is refused as a result and needs a manual contact. On
 * real CAD such parts mate through their thickness bands, whose normals do oppose.
 */
export const DEFAULT_MAX_FACING_COSINE = -0.5;

export interface ContactDetectionOptions {
  /** A node pairs up when a triangle of another part is closer than this, metres. */
  tolerance?: number;
  /** Patches with fewer node pairs than this are discarded, unless they meet minPatchArea. */
  minPairs?: number;
  /** Area, m², that keeps a patch with fewer than minPairs pairs. See DEFAULT_MIN_PATCH_AREA_RATIO. */
  minPatchArea?: number;
  /** W/(m²·K) for every detected contact. */
  conductance?: number;
  /** Upper bound on normal·normal for a match; see DEFAULT_MAX_FACING_COSINE. */
  maxFacingCosine?: number;
  idPrefix?: string;
  /** Reuse a BVH already built over this model. */
  bvh?: Bvh;
}

export interface ManualContactOptions {
  conductance?: number;
  id?: string;
  /** Nodes further apart than this are left unpaired, metres. Default: no limit. */
  maxDistance?: number;
}

export function detectContacts(
  model: ThermalModel,
  options: ContactDetectionOptions = {},
): Contact[] {
  const tolerance = options.tolerance ?? DEFAULT_CONTACT_TOLERANCE;
  const minPairs = Math.max(1, Math.floor(options.minPairs ?? DEFAULT_MIN_PAIRS));
  const conductance = options.conductance ?? PERFECT_CONTACT;
  const maxFacingCosine = options.maxFacingCosine ?? DEFAULT_MAX_FACING_COSINE;
  const idPrefix = options.idPrefix ?? 'contact';
  if (!(tolerance > 0)) throw new Error(`contact tolerance must be positive, got ${tolerance}`);

  const pairs = findContactPairs(model, {
    tolerance,
    maxFacingCosine,
    bvh: options.bvh ?? buildBvh(model),
  });
  const patches = groupPairsIntoPatches(model, pairs);

  const minPatchArea = options.minPatchArea ?? meanNodeArea(model) * DEFAULT_MIN_PATCH_AREA_RATIO;
  const contacts: Contact[] = [];
  const countByLabel = new Map<string, number>();
  for (const patch of patches) {
    const area = patch.reduce((total, pair) => total + pairs.area[pair], 0);
    if (patch.length < minPairs && area < minPatchArea) continue;
    const partA = model.parts[model.nodePart[pairs.a[patch[0]]]];
    const partB = model.parts[model.nodePart[pairs.b[patch[0]]]];
    // Named after the parts and numbered within that pairing: readable in the UI,
    // unique across the model, and stable as long as the mesh is.
    const label = `${idPrefix}-${slugify(partA.name)}-${slugify(partB.name)}`;
    const index = (countByLabel.get(label) ?? 0) + 1;
    countByLabel.set(label, index);
    contacts.push(
      buildContact(
        `${label}-${index}`,
        partA.id,
        partB.id,
        patch.map((pair) => pairs.a[pair]),
        patch.map((pair) => pairs.b[pair]),
        patch.map((pair) => pairs.area[pair]),
        conductance,
        true,
      ),
    );
  }
  return contacts;
}

interface ContactPairs {
  /** Node on the lower-index part of the pairing. */
  a: number[];
  /** Node on the higher-index part. Both orientations of a joint collapse onto one pairing. */
  b: number[];
  area: number[];
  /** Where the surfaces meet, xyz per pair. */
  point: number[];
  /** Local node spacing at the pair, metres — the scale on which pairs count as neighbours. */
  spacing: number[];
  pairsOfNode: Map<number, number[]>;
  count: number;
}

interface PairSearch {
  tolerance: number;
  maxFacingCosine: number;
  bvh: Bvh;
}

/** Links every node to the nearest facing triangle of another part within tolerance. */
function findContactPairs(model: ThermalModel, search: PairSearch): ContactPairs {
  const { nodes, nodePart, nodeArea, nodeCount, triPart, triNormal } = model;
  const nodeNormal = nodeNormals(model);
  const pairs: ContactPairs = {
    a: [],
    b: [],
    area: [],
    point: [],
    spacing: [],
    pairsOfNode: new Map(),
    count: 0,
  };
  const pairOfKey = new Map<number, number>();

  let queryPart = 0;
  let queryNode = 0;
  let queryHasNormal = false;
  const query: ClosestPointOptions = {
    maxDistance: search.tolerance,
    accept: (triangle) => {
      if (triPart[triangle] === queryPart) return false;
      if (!queryHasNormal) return true;
      const dot =
        nodeNormal[queryNode * 3] * triNormal[triangle * 3] +
        nodeNormal[queryNode * 3 + 1] * triNormal[triangle * 3 + 1] +
        nodeNormal[queryNode * 3 + 2] * triNormal[triangle * 3 + 2];
      return dot <= search.maxFacingCosine;
    },
  };
  const closest = createClosestPointResult();

  for (let node = 0; node < nodeCount; node++) {
    const p = node * 3;
    queryNode = node;
    queryPart = nodePart[node];
    queryHasNormal = nodeNormal[p] !== 0 || nodeNormal[p + 1] !== 0 || nodeNormal[p + 2] !== 0;
    if (!closestPointInto(search.bvh, nodes[p], nodes[p + 1], nodes[p + 2], closest, query)) {
      continue;
    }

    const other = nearestVertexOf(model, closest.triangle, closest.x, closest.y, closest.z);
    const swap = nodePart[other] < queryPart;
    const a = swap ? other : node;
    const b = swap ? node : other;
    // Half, because the joint is walked from both sides: a mutually matched pair
    // ends up carrying the mean of the two tributary areas, and a patch totals the
    // joint's area instead of twice it.
    const area = nodeArea[node] / 2;
    // A node covering area A sits roughly sqrt(A) from its neighbours.
    const spacing = Math.sqrt(nodeArea[node]);

    const key = a * nodeCount + b;
    const existing = pairOfKey.get(key);
    if (existing !== undefined) {
      pairs.area[existing] += area;
      pairs.spacing[existing] = Math.max(pairs.spacing[existing], spacing);
      continue;
    }
    const pair = pairs.count++;
    pairOfKey.set(key, pair);
    pairs.a.push(a);
    pairs.b.push(b);
    pairs.area.push(area);
    pairs.point.push(closest.x, closest.y, closest.z);
    pairs.spacing.push(spacing);
    addPairOfNode(pairs.pairsOfNode, a, pair);
    addPairOfNode(pairs.pairsOfNode, b, pair);
  }
  return pairs;
}

/**
 * Builds a contact by hand from two node sets — the user's "these two faces are
 * bonded" action, which has to work even when the faces are further apart than
 * proximity detection would ever accept.
 */
export function createContact(
  model: ThermalModel,
  nodesA: ArrayLike<number>,
  nodesB: ArrayLike<number>,
  options: ManualContactOptions = {},
): Contact {
  if (nodesA.length === 0 || nodesB.length === 0) {
    throw new Error('a contact needs a non-empty node set on both sides');
  }
  const partA = model.nodePart[nodesA[0]];
  const partB = model.nodePart[nodesB[0]];
  if (partA === partB) {
    throw new Error(`both node sets are on part ${model.parts[partA].id}`);
  }

  // Pair from the denser set into the sparser one, so every node of the fine mesh
  // gets a path across the joint instead of bottlenecking through a few nodes.
  const denseIsA = nodesA.length >= nodesB.length;
  const dense = denseIsA ? nodesA : nodesB;
  const sparse = denseIsA ? nodesB : nodesA;
  const spacing = estimateSpacing(model, sparse);
  const hash = buildSpatialHash(model.nodes, spacing, { indices: sparse });
  const searchLimit = Math.min(options.maxDistance ?? Infinity, farthestSpan(model, sparse));

  const linkedDense: number[] = [];
  const linkedSparse: number[] = [];
  const areas: number[] = [];
  for (let i = 0; i < dense.length; i++) {
    const node = dense[i];
    const p = node * 3;
    const match = nearestWithinExpandingRadius(
      hash,
      model.nodes[p],
      model.nodes[p + 1],
      model.nodes[p + 2],
      spacing,
      searchLimit,
    );
    if (match < 0) continue;
    linkedDense.push(node);
    linkedSparse.push(match);
    areas.push(Math.min(model.nodeArea[node], model.nodeArea[match]));
  }
  if (linkedDense.length === 0) {
    throw new Error('no node of either set was within maxDistance of the other set');
  }

  return buildContact(
    options.id ?? `contact-manual-${model.parts[partA].id}-${model.parts[partB].id}`,
    model.parts[partA].id,
    model.parts[partB].id,
    denseIsA ? linkedDense : linkedSparse,
    denseIsA ? linkedSparse : linkedDense,
    areas,
    options.conductance ?? PERFECT_CONTACT,
    false,
  );
}

/** Total contact area of a contact, m². */
export function contactArea(contact: Contact): number {
  let total = 0;
  for (let i = 0; i < contact.pairArea.length; i++) total += contact.pairArea[i];
  return total;
}

/**
 * Where a contact sits: the area-weighted midpoint of its node pairs, metres.
 *
 * Two patches of the same part pairing are alike in everything the UI shows except
 * this, so it is what tells "four corners of one bezel" from "the same joint found
 * four times" without opening the overlay.
 */
export function contactCentroid(model: ThermalModel, contact: Contact): Vec3 {
  let weight = 0;
  for (let i = 0; i < contact.pairArea.length; i++) weight += contact.pairArea[i];
  // A degenerate mesh carries no area; fall back to a plain mean over the pairs.
  const uniform = !(weight > 0);
  let x = 0;
  let y = 0;
  let z = 0;
  let total = 0;
  for (let i = 0; i < contact.pairArea.length; i++) {
    const a = contact.nodePairs[i * 2] * 3;
    const b = contact.nodePairs[i * 2 + 1] * 3;
    const share = uniform ? 1 : contact.pairArea[i];
    x += (model.nodes[a] + model.nodes[b]) * 0.5 * share;
    y += (model.nodes[a + 1] + model.nodes[b + 1]) * 0.5 * share;
    z += (model.nodes[a + 2] + model.nodes[b + 2]) * 0.5 * share;
    total += share;
  }
  return total > 0 ? [x / total, y / total, z / total] : [0, 0, 0];
}

function buildContact(
  id: string,
  partA: string,
  partB: string,
  sideA: ArrayLike<number>,
  sideB: ArrayLike<number>,
  areas: ArrayLike<number>,
  conductance: number,
  autoDetected: boolean,
): Contact {
  const nodePairs = new Uint32Array(areas.length * 2);
  const pairArea = new Float32Array(areas.length);
  for (let i = 0; i < areas.length; i++) {
    nodePairs[i * 2] = sideA[i];
    nodePairs[i * 2 + 1] = sideB[i];
    pairArea[i] = areas[i];
  }
  return { id, partA, partB, nodePairs, pairArea, conductance, autoDetected, enabled: true };
}

/**
 * A patch is a set of pairs connected through a shared node, along a mesh edge, or
 * by sitting within one node spacing of each other.
 *
 * That last rule is what makes a non-conformal joint one contact. Two independently
 * tessellated faces share neither nodes nor edges, and where a fine part lands on a
 * coarse lump a whole mating face reduces to a few scattered vertices — under mesh
 * adjacency alone each becomes its own one-pair patch and `minPairs` then throws the
 * joint away. Proximity is the same "these touch side by side" notion the shared-edge
 * rule expresses on a conformal mesh.
 */
function groupPairsIntoPatches(model: ThermalModel, pairs: ContactPairs): number[][] {
  const { a: pairA, b: pairB, pairsOfNode, count } = pairs;
  const parent = new Int32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;

  const find = (pair: number): number => {
    let root = pair;
    while (parent[root] !== root) root = parent[root];
    while (parent[pair] !== root) {
      const next = parent[pair];
      parent[pair] = root;
      pair = next;
    }
    return root;
  };
  const union = (x: number, y: number): void => {
    // Never merge across different part pairings — a Contact joins exactly two parts.
    if (model.nodePart[pairA[x]] !== model.nodePart[pairA[y]]) return;
    if (model.nodePart[pairB[x]] !== model.nodePart[pairB[y]]) return;
    const rootX = find(x);
    const rootY = find(y);
    if (rootX !== rootY) parent[rootY] = rootX;
  };

  for (const shared of pairsOfNode.values()) {
    for (let i = 1; i < shared.length; i++) union(shared[0], shared[i]);
  }
  for (let t = 0; t < model.triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const u = pairsOfNode.get(model.tris[t * 3 + e]);
      const v = pairsOfNode.get(model.tris[t * 3 + ((e + 1) % 3)]);
      if (u && v) union(u[0], v[0]);
    }
  }
  unionNeighbouringPairs(pairs, union);

  const patchOf = new Map<number, number[]>();
  for (let pair = 0; pair < count; pair++) {
    const root = find(pair);
    const patch = patchOf.get(root);
    if (patch) patch.push(pair);
    else patchOf.set(root, [pair]);
  }
  return [...patchOf.values()];
}

/** Unions pairs whose contact points lie within the local node spacing of each other. */
function unionNeighbouringPairs(pairs: ContactPairs, union: (x: number, y: number) => void): void {
  if (pairs.count === 0) return;
  const points = Float32Array.from(pairs.point);
  let meanSpacing = 0;
  for (const spacing of pairs.spacing) meanSpacing += spacing;
  meanSpacing = Math.max(meanSpacing / pairs.count, 1e-9);

  const hash = buildSpatialHash(points, meanSpacing);
  for (let pair = 0; pair < pairs.count; pair++) {
    const p = pair * 3;
    forEachPointInRadius(
      hash,
      points[p],
      points[p + 1],
      points[p + 2],
      pairs.spacing[pair],
      (j) => {
        if (j !== pair) union(pair, j);
      },
    );
  }
}

/**
 * Area-weighted average of each node's incident triangle normals, normalised.
 * This is the node's own idea of which way its surface faces, which is what the
 * facing filter compares the candidate triangle against.
 *
 * A node whose incident normals cancel — the rim of a zero-thickness sheet, say —
 * gets a zero vector, and the caller skips the facing test for it rather than
 * judging the joint from a direction the geometry does not actually have.
 */
function nodeNormals(model: ThermalModel): Float32Array {
  const { tris, triArea, triNormal, triCount, nodeCount } = model;
  const normals = new Float32Array(nodeCount * 3);
  for (let t = 0; t < triCount; t++) {
    const area = triArea[t];
    for (let c = 0; c < 3; c++) {
      const n = tris[t * 3 + c] * 3;
      normals[n] += triNormal[t * 3] * area;
      normals[n + 1] += triNormal[t * 3 + 1] * area;
      normals[n + 2] += triNormal[t * 3 + 2] * area;
    }
  }
  for (let n = 0; n < nodeCount; n++) {
    const length = Math.hypot(normals[n * 3], normals[n * 3 + 1], normals[n * 3 + 2]);
    if (length === 0) continue;
    normals[n * 3] /= length;
    normals[n * 3 + 1] /= length;
    normals[n * 3 + 2] /= length;
  }
  return normals;
}

function meanNodeArea(model: ThermalModel): number {
  if (model.nodeCount === 0) return 0;
  let total = 0;
  for (let n = 0; n < model.nodeCount; n++) total += model.nodeArea[n];
  return total / model.nodeCount;
}

/** The corner of `triangle` closest to (x, y, z) — the node the match links to. */
function nearestVertexOf(
  model: ThermalModel,
  triangle: number,
  x: number,
  y: number,
  z: number,
): number {
  let best = model.tris[triangle * 3];
  let bestDistanceSquared = Infinity;
  for (let c = 0; c < 3; c++) {
    const node = model.tris[triangle * 3 + c];
    const p = node * 3;
    const dx = model.nodes[p] - x;
    const dy = model.nodes[p + 1] - y;
    const dz = model.nodes[p + 2] - z;
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      best = node;
    }
  }
  return best;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'part';
}

function addPairOfNode(pairsOfNode: Map<number, number[]>, node: number, pair: number): void {
  const pairs = pairsOfNode.get(node);
  if (pairs) pairs.push(pair);
  else pairsOfNode.set(node, [pair]);
}

/**
 * Typical distance between neighbouring nodes in a set, from the area they carry:
 * a patch of n nodes covering area A has nodes roughly sqrt(A/n) apart. Used as the
 * spatial hash cell size and as the first search radius, so both track mesh density
 * instead of assuming one.
 */
function estimateSpacing(model: ThermalModel, indices: ArrayLike<number>): number {
  let area = 0;
  for (let i = 0; i < indices.length; i++) area += model.nodeArea[indices[i]];
  const fromArea = Math.sqrt(area / indices.length);
  if (fromArea > 0) return fromArea;
  // Degenerate meshes carry no area; fall back to the set's own extent.
  const span = farthestSpan(model, indices);
  return span > 0 ? span / Math.sqrt(indices.length) : 1e-6;
}

/**
 * Nearest indexed point, widening the search until something is found or `maxRadius`
 * is passed. Manual contacts join faces the user knows are bonded but which may sit
 * far apart in a sloppy model, so a single fixed radius either misses them or scans
 * the whole set for every node.
 */
function nearestWithinExpandingRadius(
  hash: SpatialHash,
  x: number,
  y: number,
  z: number,
  startRadius: number,
  maxRadius: number,
): number {
  for (let radius = startRadius; ; radius *= 2) {
    const capped = Math.min(radius, maxRadius);
    const found = nearestPoint(hash, x, y, z, capped);
    if (found >= 0) return found;
    if (capped >= maxRadius) return -1;
  }
}

function farthestSpan(model: ThermalModel, indices: ArrayLike<number>): number {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < indices.length; i++) {
    const p = indices[i] * 3;
    minX = Math.min(minX, model.nodes[p]);
    minY = Math.min(minY, model.nodes[p + 1]);
    minZ = Math.min(minZ, model.nodes[p + 2]);
    maxX = Math.max(maxX, model.nodes[p]);
    maxY = Math.max(maxY, model.nodes[p + 1]);
    maxZ = Math.max(maxZ, model.nodes[p + 2]);
  }
  const { min, max } = model.bbox;
  const modelDiagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const setDiagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  return Math.max(modelDiagonal, setDiagonal, 1e-6);
}
