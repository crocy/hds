/**
 * Raycast selection at four granularities — part, face, edge, point — plus the
 * highlight layers that draw what is hovered, what is selected, and what is
 * staged into a boundary-condition group.
 *
 * Everything above the `Picker` class is pure array maths with no renderer
 * involved, so it is unit-testable in Node. `Picker` is the thin three.js shell
 * that turns a pointer position into those calls.
 *
 * Highlighting never touches the mesh's colour attribute — that belongs to the
 * temperature field. Highlights are separate objects that share the position
 * buffer and carry their own index.
 */

import * as THREE from 'three';
import type { Target, ThermalModel, Vec3 } from '@/core/types';
import { applySelection } from '@/core/targets';

export type SelectionMode = 'part' | 'face' | 'edge' | 'point';

export const SELECTION_MODES: readonly SelectionMode[] = ['part', 'face', 'edge', 'point'];

/** Hotkeys 1–4, per the design's viewer section. */
export const SELECTION_MODE_HOTKEYS: Record<string, SelectionMode> = {
  '1': 'part',
  '2': 'face',
  '3': 'edge',
  '4': 'point',
};

export interface PickHit {
  mode: SelectionMode;
  /**
   * What would be selected at the active granularity. Null when the mode found
   * nothing — edge mode with no chain inside the screen-space threshold — while
   * the rest of the hit is still valid for the readout.
   */
  target: Target | null;
  /** World-space point on the surface, metres. */
  point: Vec3;
  triIndex: number;
  partIndex: number;
  partId: string;
  faceId: number;
  /** Nearest node to the hit. Always populated; drives the temperature readout. */
  nodeIndex: number;
  /** Nearest feature-edge chain within the threshold, when the mode asked for one. */
  edgeId: number | null;
  /** Barycentric interpolation of the node field, or null when no field is loaded. */
  temperature: number | null;
  /** Distance from the camera along the ray, metres. */
  distance: number;
}

// ---------------------------------------------------------------------------
// Pure maths
// ---------------------------------------------------------------------------

/** Squared distance from p to segment ab, and the parameter t of the closest point. */
export function distanceToSegmentSquared(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): { distanceSquared: number; t: number } {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const lengthSquared = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (lengthSquared > 0) {
    t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / lengthSquared;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  const dz = pz - (az + abz * t);
  return { distanceSquared: dx * dx + dy * dy + dz * dz, t };
}

/**
 * Barycentric weights of `p` projected onto triangle `abc`, written into `out`.
 * Returns false for a degenerate triangle, in which case `out` is untouched.
 */
export function barycentricWeights(
  p: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  out: [number, number, number],
): boolean {
  const v0x = b[0] - a[0];
  const v0y = b[1] - a[1];
  const v0z = b[2] - a[2];
  const v1x = c[0] - a[0];
  const v1y = c[1] - a[1];
  const v1z = c[2] - a[2];
  const v2x = p[0] - a[0];
  const v2y = p[1] - a[1];
  const v2z = p[2] - a[2];

  const d00 = v0x * v0x + v0y * v0y + v0z * v0z;
  const d01 = v0x * v1x + v0y * v1y + v0z * v1z;
  const d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const d20 = v2x * v0x + v2y * v0y + v2z * v0z;
  const d21 = v2x * v1x + v2y * v1y + v2z * v1z;
  const denominator = d00 * d11 - d01 * d01;
  if (!(Math.abs(denominator) > 1e-20)) return false;

  const v = (d11 * d20 - d01 * d21) / denominator;
  const w = (d00 * d21 - d01 * d20) / denominator;
  out[0] = 1 - v - w;
  out[1] = v;
  out[2] = w;
  return true;
}

const scratchWeights: [number, number, number] = [0, 0, 0];

/** Interpolates a per-node field at a point on a triangle. Falls back to the mean. */
export function interpolateOnTriangle(
  model: ThermalModel,
  triIndex: number,
  values: ArrayLike<number>,
  point: Vec3,
): number {
  const ia = model.tris[triIndex * 3];
  const ib = model.tris[triIndex * 3 + 1];
  const ic = model.tris[triIndex * 3 + 2];
  const a = nodeAt(model.nodes, ia);
  const b = nodeAt(model.nodes, ib);
  const c = nodeAt(model.nodes, ic);
  if (!barycentricWeights(point, a, b, c, scratchWeights)) {
    return (values[ia] + values[ib] + values[ic]) / 3;
  }
  return (
    scratchWeights[0] * values[ia] + scratchWeights[1] * values[ib] + scratchWeights[2] * values[ic]
  );
}

function nodeAt(nodes: Float32Array, index: number): Vec3 {
  return [nodes[index * 3], nodes[index * 3 + 1], nodes[index * 3 + 2]];
}

/** Nearest of a triangle's own three vertices. Cheap, and bounds the grid search. */
export function nearestNodeInTriangle(model: ThermalModel, triIndex: number, point: Vec3): number {
  let best = -1;
  let bestDistanceSquared = Infinity;
  for (let k = 0; k < 3; k++) {
    const node = model.tris[triIndex * 3 + k];
    const dx = point[0] - model.nodes[node * 3];
    const dy = point[1] - model.nodes[node * 3 + 1];
    const dz = point[2] - model.nodes[node * 3 + 2];
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      best = node;
    }
  }
  return best;
}

/** Uniform-grid bucketing of the node cloud, so hover does not scan every node. */
export interface NodeGrid {
  cellSize: number;
  origin: Vec3;
  dims: readonly [number, number, number];
  /** Prefix-sum offsets into `nodeIndices`, length cellCount + 1. */
  cellStart: Uint32Array;
  nodeIndices: Uint32Array;
}

const MAX_GRID_CELLS = 1 << 21;

export function buildNodeGrid(nodes: Float32Array, nodeCount: number, cellSize?: number): NodeGrid {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let n = 0; n < nodeCount; n++) {
    for (let k = 0; k < 3; k++) {
      const v = nodes[n * 3 + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!Number.isFinite(min[0])) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }

  const extent: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const diagonal = Math.hypot(extent[0], extent[1], extent[2]) || 1;
  let size =
    cellSize && cellSize > 0 ? cellSize : diagonal / clamp(Math.cbrt(nodeCount / 4), 1, 128);

  let dims = gridDims(extent, size);
  while (dims[0] * dims[1] * dims[2] > MAX_GRID_CELLS) {
    size *= 2;
    dims = gridDims(extent, size);
  }

  const cellCount = dims[0] * dims[1] * dims[2];
  const counts = new Uint32Array(cellCount + 1);
  const cellOf = new Uint32Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) {
    const cell = cellIndex(nodes[n * 3], nodes[n * 3 + 1], nodes[n * 3 + 2], min, size, dims);
    cellOf[n] = cell;
    counts[cell + 1]++;
  }
  for (let c = 0; c < cellCount; c++) counts[c + 1] += counts[c];

  const cursor = counts.slice(0, cellCount);
  const nodeIndices = new Uint32Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) nodeIndices[cursor[cellOf[n]]++] = n;

  return { cellSize: size, origin: min, dims, cellStart: counts, nodeIndices };
}

function gridDims(extent: Vec3, cellSize: number): [number, number, number] {
  return [
    Math.max(1, Math.ceil(extent[0] / cellSize) + 1),
    Math.max(1, Math.ceil(extent[1] / cellSize) + 1),
    Math.max(1, Math.ceil(extent[2] / cellSize) + 1),
  ];
}

function cellIndex(
  x: number,
  y: number,
  z: number,
  origin: Vec3,
  cellSize: number,
  dims: readonly [number, number, number],
): number {
  const ix = clampInt(Math.floor((x - origin[0]) / cellSize), 0, dims[0] - 1);
  const iy = clampInt(Math.floor((y - origin[1]) / cellSize), 0, dims[1] - 1);
  const iz = clampInt(Math.floor((z - origin[2]) / cellSize), 0, dims[2] - 1);
  return (iz * dims[1] + iy) * dims[0] + ix;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Nearest node to `point` within `maxDistance`, or -1. Searches cell shells
 * outwards and stops once the shell itself is further away than the best hit.
 */
export function findNearestNode(
  grid: NodeGrid,
  nodes: Float32Array,
  point: Vec3,
  maxDistance = Infinity,
  accept?: (nodeIndex: number) => boolean,
): number {
  const { cellSize, origin, dims, cellStart, nodeIndices } = grid;
  const cx = clampInt(Math.floor((point[0] - origin[0]) / cellSize), 0, dims[0] - 1);
  const cy = clampInt(Math.floor((point[1] - origin[1]) / cellSize), 0, dims[1] - 1);
  const cz = clampInt(Math.floor((point[2] - origin[2]) / cellSize), 0, dims[2] - 1);

  const maxRing = Number.isFinite(maxDistance)
    ? Math.min(Math.max(...dims), Math.ceil(maxDistance / cellSize) + 1)
    : Math.max(...dims);

  let best = -1;
  let bestDistanceSquared = Number.isFinite(maxDistance) ? maxDistance * maxDistance : Infinity;

  for (let ring = 0; ring <= maxRing; ring++) {
    if (best >= 0) {
      const reach = (ring - 1) * cellSize;
      if (reach > 0 && reach * reach > bestDistanceSquared) break;
    }
    for (let iz = cz - ring; iz <= cz + ring; iz++) {
      if (iz < 0 || iz >= dims[2]) continue;
      for (let iy = cy - ring; iy <= cy + ring; iy++) {
        if (iy < 0 || iy >= dims[1]) continue;
        const onShellPlane = Math.abs(iz - cz) === ring || Math.abs(iy - cy) === ring;
        for (let ix = cx - ring; ix <= cx + ring; ix++) {
          if (ix < 0 || ix >= dims[0]) continue;
          if (!onShellPlane && Math.abs(ix - cx) !== ring) continue;
          const cell = (iz * dims[1] + iy) * dims[0] + ix;
          for (let s = cellStart[cell]; s < cellStart[cell + 1]; s++) {
            const node = nodeIndices[s];
            if (accept && !accept(node)) continue;
            const dx = point[0] - nodes[node * 3];
            const dy = point[1] - nodes[node * 3 + 1];
            const dz = point[2] - nodes[node * 3 + 2];
            const distanceSquared = dx * dx + dy * dy + dz * dz;
            if (distanceSquared < bestDistanceSquared) {
              bestDistanceSquared = distanceSquared;
              best = node;
            }
          }
        }
      }
    }
  }
  return best;
}

export interface EdgeHit {
  edgeId: number;
  distance: number;
  /** Nearest node on that chain — the natural anchor for a point selection. */
  nodeIndex: number;
}

/** Nearest feature-edge chain to a point, optionally restricted to one part. */
export function nearestEdgeChain(
  model: ThermalModel,
  point: Vec3,
  maxDistance = Infinity,
  partIndex?: number,
): EdgeHit | null {
  let bestDistanceSquared = Number.isFinite(maxDistance) ? maxDistance * maxDistance : Infinity;
  let bestEdge = -1;
  let bestNode = -1;

  for (const chain of model.featureEdges) {
    if (partIndex !== undefined && chain.partIndex !== partIndex) continue;
    for (let i = 0; i + 1 < chain.nodes.length; i++) {
      const a = chain.nodes[i];
      const b = chain.nodes[i + 1];
      const { distanceSquared, t } = distanceToSegmentSquared(
        point[0],
        point[1],
        point[2],
        model.nodes[a * 3],
        model.nodes[a * 3 + 1],
        model.nodes[a * 3 + 2],
        model.nodes[b * 3],
        model.nodes[b * 3 + 1],
        model.nodes[b * 3 + 2],
      );
      if (distanceSquared < bestDistanceSquared) {
        bestDistanceSquared = distanceSquared;
        bestEdge = chain.id;
        bestNode = t < 0.5 ? a : b;
      }
    }
  }
  if (bestEdge < 0) return null;
  return { edgeId: bestEdge, distance: Math.sqrt(bestDistanceSquared), nodeIndex: bestNode };
}

/** World-space size of one pixel at `distance` from a perspective camera. */
export function worldPerPixel(
  fovDegrees: number,
  viewportHeightPx: number,
  distance: number,
): number {
  if (viewportHeightPx <= 0) return 0;
  return (2 * Math.tan((fovDegrees * Math.PI) / 360) * Math.abs(distance)) / viewportHeightPx;
}

export function partIndexOf(model: ThermalModel, partId: string): number {
  return model.parts.findIndex((part) => part.id === partId);
}

export interface ResolvedTarget {
  triangles: Uint32Array;
  nodes: Uint32Array;
}

const EMPTY_TARGET: ResolvedTarget = { triangles: new Uint32Array(0), nodes: new Uint32Array(0) };

/**
 * A `Target` as concrete triangle and node index sets. Shared by the highlight
 * layer and the overlays, and the same resolution the solver applies to a
 * boundary condition.
 */
export function resolveTarget(model: ThermalModel, target: Target): ResolvedTarget {
  const partIndex = partIndexOf(model, target.partId);
  if (partIndex < 0) return EMPTY_TARGET;
  const part = model.parts[partIndex];

  switch (target.type) {
    case 'part': {
      const [triStart, triEnd] = part.triRange;
      const [nodeStart, nodeEnd] = part.nodeRange;
      const triangles = new Uint32Array(Math.max(0, triEnd - triStart));
      for (let i = 0; i < triangles.length; i++) triangles[i] = triStart + i;
      const nodes = new Uint32Array(Math.max(0, nodeEnd - nodeStart));
      for (let i = 0; i < nodes.length; i++) nodes[i] = nodeStart + i;
      return { triangles, nodes };
    }
    case 'face': {
      const [triStart, triEnd] = part.triRange;
      const triangles: number[] = [];
      const nodeSet = new Set<number>();
      for (let t = triStart; t < triEnd; t++) {
        if (model.triFace[t] !== target.faceId) continue;
        triangles.push(t);
        nodeSet.add(model.tris[t * 3]);
        nodeSet.add(model.tris[t * 3 + 1]);
        nodeSet.add(model.tris[t * 3 + 2]);
      }
      return { triangles: Uint32Array.from(triangles), nodes: Uint32Array.from(nodeSet) };
    }
    case 'edge': {
      const chain = model.featureEdges.find(
        (candidate) => candidate.id === target.edgeId && candidate.partIndex === partIndex,
      );
      if (!chain) return EMPTY_TARGET;
      return { triangles: new Uint32Array(0), nodes: Uint32Array.from(chain.nodes) };
    }
    case 'node':
      return { triangles: new Uint32Array(0), nodes: Uint32Array.of(target.nodeId) };
    default:
      return EMPTY_TARGET;
  }
}

/** Human-readable label for the selection panel and the readout. */
export function describeTarget(model: ThermalModel, target: Target): string {
  const part = model.parts.find((candidate) => candidate.id === target.partId);
  const partName = part?.name ?? target.partId;
  switch (target.type) {
    case 'part':
      return partName;
    case 'face':
      return `${partName} · face ${target.faceId}`;
    case 'edge':
      return `${partName} · edge ${target.edgeId}`;
    case 'node':
      return `${partName} · node ${target.nodeId}`;
    default:
      return partName;
  }
}

// ---------------------------------------------------------------------------
// Highlight layer
// ---------------------------------------------------------------------------

export const HOVER_COLOR = 0xffffff;
export const SELECTION_COLOR = 0x22aaff;
/** The boundary-condition group being staged. Amber, so it never reads as the selection. */
export const DRAFT_COLOR = 0xffb020;

const HIGHLIGHT_POINT_SIZE = 9;

/** Draws a triangle / edge / point subset in one colour, sharing the mesh's positions. */
class HighlightObjects {
  readonly group = new THREE.Group();
  private readonly faces: THREE.Mesh;
  private readonly lines: THREE.LineSegments;
  private readonly points: THREE.Points;
  private readonly faceGeometry = new THREE.BufferGeometry();
  private readonly lineGeometry = new THREE.BufferGeometry();
  private readonly pointGeometry = new THREE.BufferGeometry();
  private faceIndices = new Uint32Array(0);
  private lineIndices = new Uint32Array(0);
  private pointPositions = new Float32Array(0);

  constructor(color: number, faceOpacity: number, renderOrder: number) {
    const faceMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: faceOpacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      toneMapped: false,
    });
    const lineMaterial = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      toneMapped: false,
    });
    const pointMaterial = new THREE.PointsMaterial({
      color,
      size: HIGHLIGHT_POINT_SIZE,
      sizeAttenuation: false,
      depthTest: false,
      transparent: true,
      toneMapped: false,
    });

    this.faces = new THREE.Mesh(this.faceGeometry, faceMaterial);
    this.lines = new THREE.LineSegments(this.lineGeometry, lineMaterial);
    this.points = new THREE.Points(this.pointGeometry, pointMaterial);
    for (const object of [this.faces, this.lines, this.points]) {
      object.renderOrder = renderOrder;
      object.frustumCulled = false;
      object.visible = false;
      this.group.add(object);
    }
  }

  setPositionSource(attribute: THREE.BufferAttribute | null): void {
    if (attribute) {
      this.faceGeometry.setAttribute('position', attribute);
      this.lineGeometry.setAttribute('position', attribute);
    } else {
      this.faceGeometry.deleteAttribute('position');
      this.lineGeometry.deleteAttribute('position');
    }
  }

  setTriangles(model: ThermalModel, triangles: ArrayLike<number>): void {
    const count = triangles.length * 3;
    if (count === 0) {
      this.faces.visible = false;
      return;
    }
    if (this.faceIndices.length < count) {
      this.faceIndices = new Uint32Array(nextCapacity(count));
      this.faceGeometry.setIndex(new THREE.BufferAttribute(this.faceIndices, 1));
    }
    for (let i = 0; i < triangles.length; i++) {
      const t = triangles[i];
      this.faceIndices[i * 3] = model.tris[t * 3];
      this.faceIndices[i * 3 + 1] = model.tris[t * 3 + 1];
      this.faceIndices[i * 3 + 2] = model.tris[t * 3 + 2];
    }
    const index = this.faceGeometry.getIndex();
    if (index) index.needsUpdate = true;
    this.faceGeometry.setDrawRange(0, count);
    this.faces.visible = true;
  }

  /** `paths` are node index runs; consecutive pairs become segments. */
  setPaths(paths: ArrayLike<number>[]): void {
    let count = 0;
    for (const path of paths) count += Math.max(0, path.length - 1) * 2;
    if (count === 0) {
      this.lines.visible = false;
      return;
    }
    if (this.lineIndices.length < count) {
      this.lineIndices = new Uint32Array(nextCapacity(count));
      this.lineGeometry.setIndex(new THREE.BufferAttribute(this.lineIndices, 1));
    }
    let cursor = 0;
    for (const path of paths) {
      for (let i = 0; i + 1 < path.length; i++) {
        this.lineIndices[cursor++] = path[i];
        this.lineIndices[cursor++] = path[i + 1];
      }
    }
    const index = this.lineGeometry.getIndex();
    if (index) index.needsUpdate = true;
    this.lineGeometry.setDrawRange(0, count);
    this.lines.visible = true;
  }

  setNodes(model: ThermalModel, nodes: ArrayLike<number>): void {
    if (nodes.length === 0) {
      this.points.visible = false;
      return;
    }
    const needed = nodes.length * 3;
    if (this.pointPositions.length < needed) {
      this.pointPositions = new Float32Array(nextCapacity(needed));
      this.pointGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(this.pointPositions, 3),
      );
    }
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      this.pointPositions[i * 3] = model.nodes[node * 3];
      this.pointPositions[i * 3 + 1] = model.nodes[node * 3 + 1];
      this.pointPositions[i * 3 + 2] = model.nodes[node * 3 + 2];
    }
    const attribute = this.pointGeometry.getAttribute('position');
    if (attribute) attribute.needsUpdate = true;
    this.pointGeometry.setDrawRange(0, nodes.length);
    this.points.visible = true;
  }

  clear(): void {
    this.faces.visible = false;
    this.lines.visible = false;
    this.points.visible = false;
  }

  dispose(): void {
    // Position is shared with the main geometry; drop the reference first so the
    // shared buffer is not torn down with these throwaway geometries.
    this.setPositionSource(null);
    for (const geometry of [this.faceGeometry, this.lineGeometry, this.pointGeometry]) {
      geometry.dispose();
    }
    for (const object of [this.faces, this.lines, this.points]) {
      (object.material as THREE.Material).dispose();
    }
    this.group.clear();
  }
}

function nextCapacity(needed: number): number {
  let capacity = 1024;
  while (capacity < needed) capacity *= 2;
  return capacity;
}

export interface PickerOptions {
  /** Screen-space radius for edge picking, pixels. */
  edgePixelThreshold?: number;
  /** Screen-space radius for point picking, pixels. */
  pointPixelThreshold?: number;
}

/** Should a hit on this part, at this point, be pickable? (hidden parts, clipping) */
export type PickFilter = (partIndex: number, point: THREE.Vector3) => boolean;

export class Picker {
  readonly object = new THREE.Group();

  // Render orders stack the three layers: selection at the bottom, then the draft
  // being staged over it, then hover on top of both.
  private readonly selectionHighlight = new HighlightObjects(SELECTION_COLOR, 0.4, 3);
  private readonly draftHighlight = new HighlightObjects(DRAFT_COLOR, 0.4, 4);
  private readonly hoverHighlight = new HighlightObjects(HOVER_COLOR, 0.22, 5);
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  private model: ThermalModel | null = null;
  private mesh: THREE.Mesh | null = null;
  private grid: NodeGrid | null = null;
  private temperatures: Float32Array | null = null;
  private mode: SelectionMode = 'part';
  private selection: Target[] = [];
  /** Mirrored from React, like `selection`: this is not the source of truth. */
  private draft: Target[] = [];
  private filter: PickFilter | null = null;
  private readonly edgePixelThreshold: number;
  private readonly pointPixelThreshold: number;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    options: PickerOptions = {},
  ) {
    this.edgePixelThreshold = options.edgePixelThreshold ?? 14;
    this.pointPixelThreshold = options.pointPixelThreshold ?? 18;
    this.object.name = 'picking-highlights';
    this.object.add(
      this.selectionHighlight.group,
      this.draftHighlight.group,
      this.hoverHighlight.group,
    );
  }

  setModel(model: ThermalModel | null, mesh: THREE.Mesh | null): void {
    this.model = model;
    this.mesh = mesh;
    this.selection = [];
    this.draft = [];
    this.grid = model && model.nodeCount > 0 ? buildNodeGrid(model.nodes, model.nodeCount) : null;
    const position = (mesh?.geometry.getAttribute('position') as THREE.BufferAttribute) ?? null;
    this.hoverHighlight.setPositionSource(position);
    this.selectionHighlight.setPositionSource(position);
    this.draftHighlight.setPositionSource(position);
    this.hoverHighlight.clear();
    this.selectionHighlight.clear();
    this.draftHighlight.clear();
  }

  setTemperatures(temperatures: Float32Array | null): void {
    this.temperatures = temperatures;
  }

  setFilter(filter: PickFilter | null): void {
    this.filter = filter;
  }

  setMode(mode: SelectionMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.hoverHighlight.clear();
    this.refreshSelectionHighlight();
    this.refreshDraftHighlight();
  }

  getMode(): SelectionMode {
    return this.mode;
  }

  /** Pure query: what is under these normalised device coordinates. No side effects. */
  pick(ndcX: number, ndcY: number, viewportHeightPx: number): PickHit | null {
    const model = this.model;
    const mesh = this.mesh;
    if (!model || !mesh) return null;

    this.pointer.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersections = this.raycaster.intersectObject(mesh, false);

    for (const intersection of intersections) {
      const triIndex = intersection.faceIndex;
      if (triIndex === undefined || triIndex === null) continue;
      const partIndex = model.triPart[triIndex];
      if (this.filter && !this.filter(partIndex, intersection.point)) continue;
      return this.describeHit(model, intersection, triIndex, partIndex, viewportHeightPx);
    }
    return null;
  }

  private describeHit(
    model: ThermalModel,
    intersection: THREE.Intersection,
    triIndex: number,
    partIndex: number,
    viewportHeightPx: number,
  ): PickHit {
    const point: Vec3 = [intersection.point.x, intersection.point.y, intersection.point.z];
    const part = model.parts[partIndex];
    const partId = part?.id ?? '';
    const faceId = model.triFace[triIndex];
    const pixel = worldPerPixel(this.camera.fov, viewportHeightPx, intersection.distance);

    const triangleNode = nearestNodeInTriangle(model, triIndex, point);
    let nodeIndex = triangleNode;
    if (this.grid) {
      const bound = Math.hypot(
        point[0] - model.nodes[triangleNode * 3],
        point[1] - model.nodes[triangleNode * 3 + 1],
        point[2] - model.nodes[triangleNode * 3 + 2],
      );
      const closer = findNearestNode(this.grid, model.nodes, point, bound);
      if (closer >= 0) nodeIndex = closer;
    }

    let edgeId: number | null = null;
    if (this.mode === 'edge') {
      const hit = nearestEdgeChain(model, point, pixel * this.edgePixelThreshold, partIndex);
      edgeId = hit ? hit.edgeId : null;
      if (hit) nodeIndex = hit.nodeIndex;
    }

    let target: Target | null = null;
    switch (this.mode) {
      case 'part':
        target = partId ? { type: 'part', partId } : null;
        break;
      case 'face':
        target = partId ? { type: 'face', partId, faceId } : null;
        break;
      case 'edge':
        target = partId && edgeId !== null ? { type: 'edge', partId, edgeId } : null;
        break;
      case 'point':
        target = partId ? { type: 'node', partId, nodeId: nodeIndex } : null;
        break;
    }

    const temperature = this.temperatures
      ? interpolateOnTriangle(model, triIndex, this.temperatures, point)
      : null;

    return {
      mode: this.mode,
      target,
      point,
      triIndex,
      partIndex,
      partId,
      faceId,
      nodeIndex,
      edgeId,
      temperature,
      distance: intersection.distance,
    };
  }

  /** Pick and update the hover highlight in one call. */
  hover(ndcX: number, ndcY: number, viewportHeightPx: number): PickHit | null {
    const hit = this.pick(ndcX, ndcY, viewportHeightPx);
    this.showHover(hit);
    return hit;
  }

  showHover(hit: PickHit | null): void {
    const model = this.model;
    this.hoverHighlight.clear();
    if (!hit || !hit.target || !model) return;
    this.draw(this.hoverHighlight, model, [hit.target]);
  }

  clearHover(): void {
    this.hoverHighlight.clear();
  }

  /** Commits a click. Returns the new selection. */
  select(target: Target | null, additive: boolean): Target[] {
    this.selection = applySelection(this.selection, target, additive);
    this.refreshSelectionHighlight();
    return this.getSelection();
  }

  setSelection(targets: readonly Target[]): void {
    this.selection = [...targets];
    this.refreshSelectionHighlight();
  }

  getSelection(): Target[] {
    return [...this.selection];
  }

  clearSelection(): void {
    this.setSelection([]);
  }

  setDraft(targets: readonly Target[]): void {
    this.draft = [...targets];
    this.refreshDraftHighlight();
  }

  getDraft(): Target[] {
    return [...this.draft];
  }

  private refreshSelectionHighlight(): void {
    this.selectionHighlight.clear();
    if (this.model && this.selection.length > 0) {
      this.draw(this.selectionHighlight, this.model, this.selection);
    }
  }

  private refreshDraftHighlight(): void {
    this.draftHighlight.clear();
    if (this.model && this.draft.length > 0) {
      this.draw(this.draftHighlight, this.model, this.draft);
    }
  }

  private draw(highlight: HighlightObjects, model: ThermalModel, targets: readonly Target[]): void {
    const triangles: number[] = [];
    const paths: ArrayLike<number>[] = [];
    const nodes: number[] = [];

    for (const target of targets) {
      const resolved = resolveTarget(model, target);
      if (target.type === 'edge') {
        paths.push(resolved.nodes);
      } else if (target.type === 'node') {
        for (const node of resolved.nodes) nodes.push(node);
      } else {
        for (const tri of resolved.triangles) triangles.push(tri);
      }
    }

    highlight.setTriangles(model, triangles);
    highlight.setPaths(paths);
    highlight.setNodes(model, nodes);
  }

  dispose(): void {
    this.hoverHighlight.dispose();
    this.selectionHighlight.dispose();
    this.draftHighlight.dispose();
    this.object.clear();
    this.model = null;
    this.mesh = null;
    this.grid = null;
  }
}
