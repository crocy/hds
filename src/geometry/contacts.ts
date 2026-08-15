/**
 * Contact detection: where do parts on different bodies actually touch?
 *
 * Nodes are deliberately not welded across parts, so every path for heat between
 * two parts runs through a Contact and can carry a finite conductance. A bolted
 * joint, a welded seam and two parts that merely rest against each other are the
 * same geometry and different physics.
 */

import { PERFECT_CONTACT, type Contact, type ThermalModel } from '../core/types';
import {
  buildSpatialHash,
  forEachPointInRadius,
  nearestPoint,
  type SpatialHash,
} from './spatialHash';

/** 0.2 mm, expressed in metres like everything else below the UI. */
export const DEFAULT_CONTACT_TOLERANCE = 2e-4;

/** One touching vertex is a mesh coincidence, not a joint. Two is the smallest real edge contact. */
export const DEFAULT_MIN_PAIRS = 2;

export interface ContactDetectionOptions {
  /** Nodes on different parts closer than this pair up, metres. */
  tolerance?: number;
  /** Patches with fewer node pairs than this are discarded. */
  minPairs?: number;
  /** W/(m²·K) for every detected contact. */
  conductance?: number;
  idPrefix?: string;
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
  const idPrefix = options.idPrefix ?? 'contact';
  if (!(tolerance > 0)) throw new Error(`contact tolerance must be positive, got ${tolerance}`);

  const { nodes, nodePart, nodeArea, nodeCount } = model;
  const hash = buildSpatialHash(nodes, tolerance);

  const pairA: number[] = [];
  const pairB: number[] = [];
  const pairArea: number[] = [];
  const pairsOfNode = new Map<number, number[]>();

  for (let i = 0; i < nodeCount; i++) {
    const part = nodePart[i];
    forEachPointInRadius(hash, nodes[i * 3], nodes[i * 3 + 1], nodes[i * 3 + 2], tolerance, (j) => {
      if (j <= i || nodePart[j] === part) return;
      const pair = pairA.length;
      pairA.push(i);
      pairB.push(j);
      // min, not mean: the shared area cannot exceed the smaller node's tributary
      // area, and taking the mean would invent contact area where a coarse mesh
      // meets a fine one.
      pairArea.push(Math.min(nodeArea[i], nodeArea[j]));
      addPairOfNode(pairsOfNode, i, pair);
      addPairOfNode(pairsOfNode, j, pair);
    });
  }

  const patches = groupPairsIntoPatches(model, pairA, pairB, pairsOfNode);
  const contacts: Contact[] = [];
  for (const patch of patches) {
    if (patch.length < minPairs) continue;
    const partA = model.parts[nodePart[pairA[patch[0]]]];
    const partB = model.parts[nodePart[pairB[patch[0]]]];
    contacts.push(
      buildContact(
        `${idPrefix}-${partA.id}-${partB.id}-${contacts.length}`,
        partA.id,
        partB.id,
        patch.map((pair) => pairA[pair]),
        patch.map((pair) => pairB[pair]),
        patch.map((pair) => pairArea[pair]),
        conductance,
        true,
      ),
    );
  }
  return contacts;
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
 * A patch is a set of pairs connected either through a shared node or along a mesh
 * edge. Mesh adjacency is what makes a face-to-face joint one contact: its pairs
 * share no nodes, and the node spacing is far wider than the contact tolerance.
 */
function groupPairsIntoPatches(
  model: ThermalModel,
  pairA: number[],
  pairB: number[],
  pairsOfNode: Map<number, number[]>,
): number[][] {
  const pairCount = pairA.length;
  const parent = new Int32Array(pairCount);
  for (let i = 0; i < pairCount; i++) parent[i] = i;

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

  for (const pairs of pairsOfNode.values()) {
    for (let i = 1; i < pairs.length; i++) union(pairs[0], pairs[i]);
  }
  for (let t = 0; t < model.triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const u = pairsOfNode.get(model.tris[t * 3 + e]);
      const v = pairsOfNode.get(model.tris[t * 3 + ((e + 1) % 3)]);
      if (u && v) union(u[0], v[0]);
    }
  }

  const patchOf = new Map<number, number[]>();
  for (let pair = 0; pair < pairCount; pair++) {
    const root = find(pair);
    const patch = patchOf.get(root);
    if (patch) patch.push(pair);
    else patchOf.set(root, [pair]);
  }
  return [...patchOf.values()];
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
