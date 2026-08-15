/**
 * Mesh topology derived from a *welded* triangle set: connected components,
 * face regions and feature edges.
 *
 * Everything here assumes coincident vertices have already been merged by
 * `build.ts`. On an unwelded tessellation every edge looks like a boundary edge,
 * every triangle looks like its own component, and all three answers are wrong.
 */

import type { EdgeChain } from '../core/types';

/** Dihedral angle above which an edge is a feature edge and stops a face region. */
export const DEFAULT_FEATURE_ANGLE_DEG = 20;

export interface EdgeAdjacency {
  edgeCount: number;
  /** Undirected edge endpoints, 2 per edge, low node index first. */
  edgeNodes: Uint32Array;
  /** Up to two adjacent triangles per edge; −1 for an empty slot. */
  edgeTris: Int32Array;
  /** Triangles using each edge. 1 = boundary, 2 = manifold, >2 = non-manifold seam. */
  edgeUseCount: Uint32Array;
  /** Edge index per triangle corner, 3 per triangle; corner c spans nodes c and c+1. */
  triEdges: Uint32Array;
}

export function buildEdgeAdjacency(tris: Uint32Array, nodeCount: number): EdgeAdjacency {
  const triCount = tris.length / 3;
  const triEdges = new Uint32Array(triCount * 3);
  const edgeNodes: number[] = [];
  const edgeTris: number[] = [];
  const edgeUseCount: number[] = [];
  const edgeIndexByKey = new Map<number, number>();

  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const a = tris[t * 3 + c];
      const b = tris[t * 3 + ((c + 1) % 3)];
      const low = Math.min(a, b);
      const high = Math.max(a, b);
      const key = low * nodeCount + high;
      let edge = edgeIndexByKey.get(key);
      if (edge === undefined) {
        edge = edgeUseCount.length;
        edgeIndexByKey.set(key, edge);
        edgeNodes.push(low, high);
        edgeTris.push(-1, -1);
        edgeUseCount.push(0);
      }
      if (edgeUseCount[edge] < 2) edgeTris[edge * 2 + edgeUseCount[edge]] = t;
      edgeUseCount[edge]++;
      triEdges[t * 3 + c] = edge;
    }
  }

  return {
    edgeCount: edgeUseCount.length,
    edgeNodes: Uint32Array.from(edgeNodes),
    edgeTris: Int32Array.from(edgeTris),
    edgeUseCount: Uint32Array.from(edgeUseCount),
    triEdges,
  };
}

export interface ComponentSplit {
  /** Component index per triangle. */
  triComponent: Uint32Array;
  count: number;
}

/**
 * Triangles grouped by shared *vertices*, not shared edges — two bodies meeting
 * at a single node share a solver degree of freedom, so they conduct and belong
 * to the same component.
 */
export function connectedComponents(tris: Uint32Array, nodeCount: number): ComponentSplit {
  const parent = new Uint32Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) parent[n] = n;

  const find = (n: number): number => {
    let root = n;
    while (parent[root] !== root) root = parent[root];
    let walk = n;
    while (parent[walk] !== root) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  const triCount = tris.length / 3;
  for (let t = 0; t < triCount; t++) {
    union(tris[t * 3], tris[t * 3 + 1]);
    union(tris[t * 3], tris[t * 3 + 2]);
  }

  const componentByRoot = new Map<number, number>();
  const triComponent = new Uint32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const root = find(tris[t * 3]);
    let component = componentByRoot.get(root);
    if (component === undefined) {
      component = componentByRoot.size;
      componentByRoot.set(root, component);
    }
    triComponent[t] = component;
  }

  return { triComponent, count: componentByRoot.size };
}

export interface FaceRegions {
  /** Face region index per triangle. */
  triFace: Uint32Array;
  count: number;
}

/**
 * Flood-fills triangles across manifold edges whose dihedral angle is below the
 * threshold, so a planar or smoothly-curved patch behaves like a B-rep face for
 * selection. This is what STL and OBJ get instead of `brep_faces`.
 */
export function faceRegions(
  tris: Uint32Array,
  nodeCount: number,
  triNormal: Float32Array,
  angleDeg: number = DEFAULT_FEATURE_ANGLE_DEG,
): FaceRegions {
  const adjacency = buildEdgeAdjacency(tris, nodeCount);
  const triCount = tris.length / 3;
  const triFace = new Uint32Array(triCount).fill(0xffffffff);
  const threshold = (angleDeg * Math.PI) / 180;
  let count = 0;

  const stack: number[] = [];
  for (let seed = 0; seed < triCount; seed++) {
    if (triFace[seed] !== 0xffffffff) continue;
    const face = count++;
    triFace[seed] = face;
    stack.push(seed);
    while (stack.length > 0) {
      const t = stack.pop() as number;
      for (let c = 0; c < 3; c++) {
        const edge = adjacency.triEdges[t * 3 + c];
        if (adjacency.edgeUseCount[edge] !== 2) continue;
        const a = adjacency.edgeTris[edge * 2];
        const other = a === t ? adjacency.edgeTris[edge * 2 + 1] : a;
        if (other < 0 || triFace[other] !== 0xffffffff) continue;
        if (dihedralAngle(triNormal, t, other) >= threshold) continue;
        triFace[other] = face;
        stack.push(other);
      }
    }
  }

  return { triFace, count };
}

/**
 * Feature edges chained into polylines. Boundary and non-manifold edges always
 * qualify: an open shell's rim is a feature whatever the local curvature.
 */
export function featureEdgeChains(
  tris: Uint32Array,
  nodeCount: number,
  triNormal: Float32Array,
  triPart: Uint32Array,
  angleDeg: number = DEFAULT_FEATURE_ANGLE_DEG,
): EdgeChain[] {
  const adjacency = buildEdgeAdjacency(tris, nodeCount);
  const threshold = (angleDeg * Math.PI) / 180;

  const featureEdges: number[] = [];
  for (let edge = 0; edge < adjacency.edgeCount; edge++) {
    const manifold = adjacency.edgeUseCount[edge] === 2;
    if (
      !manifold ||
      dihedralAngle(triNormal, adjacency.edgeTris[edge * 2], adjacency.edgeTris[edge * 2 + 1]) >=
        threshold
    ) {
      featureEdges.push(edge);
    }
  }

  const incident = new Map<number, number[]>();
  const addIncidence = (node: number, local: number) => {
    const list = incident.get(node);
    if (list) list.push(local);
    else incident.set(node, [local]);
  };
  featureEdges.forEach((edge, local) => {
    addIncidence(adjacency.edgeNodes[edge * 2], local);
    addIncidence(adjacency.edgeNodes[edge * 2 + 1], local);
  });

  const used = new Uint8Array(featureEdges.length);
  const otherEnd = (local: number, node: number): number => {
    const edge = featureEdges[local];
    const a = adjacency.edgeNodes[edge * 2];
    return a === node ? adjacency.edgeNodes[edge * 2 + 1] : a;
  };

  const trace = (startNode: number, startLocal: number): number[] => {
    const path = [startNode];
    let node = startNode;
    let local = startLocal;
    for (;;) {
      used[local] = 1;
      node = otherEnd(local, node);
      path.push(node);
      const list = incident.get(node);
      // A junction or a dead end terminates the chain; degree 2 continues it.
      if (!list || list.length !== 2) break;
      const next = list.find((candidate) => used[candidate] === 0);
      if (next === undefined) break;
      local = next;
    }
    return path;
  };

  const chains: EdgeChain[] = [];
  const pushChain = (path: number[], startLocal: number) => {
    const edge = featureEdges[startLocal];
    const tri = adjacency.edgeTris[edge * 2] >= 0 ? adjacency.edgeTris[edge * 2] : 0;
    chains.push({
      id: chains.length,
      partIndex: triPart[tri],
      nodes: Uint32Array.from(path),
    });
  };

  for (const [node, list] of incident) {
    if (list.length === 2) continue;
    for (const local of list) {
      if (used[local] === 0) pushChain(trace(node, local), local);
    }
  }
  // Whatever is left is an all-degree-2 closed loop.
  for (let local = 0; local < featureEdges.length; local++) {
    if (used[local] === 1) continue;
    pushChain(trace(adjacency.edgeNodes[featureEdges[local] * 2], local), local);
  }

  return chains;
}

function dihedralAngle(triNormal: Float32Array, triA: number, triB: number): number {
  const dot =
    triNormal[triA * 3] * triNormal[triB * 3] +
    triNormal[triA * 3 + 1] * triNormal[triB * 3 + 1] +
    triNormal[triA * 3 + 2] * triNormal[triB * 3 + 2];
  return Math.acos(Math.min(1, Math.max(-1, dot)));
}
