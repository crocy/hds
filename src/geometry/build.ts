/**
 * Raw tessellation → `ThermalModel`: weld, derive parts, compute areas, normals
 * and the body-type guess.
 *
 * Vertex welding is the load-bearing step. Tessellators emit duplicate vertices
 * at every face seam — OCCT hands back 9240 vertices for the 4251 distinct
 * positions of the TBTE assembly — and an unwelded model is a pile of thermally
 * disconnected patches through which no heat flows at all.
 */

import type { Bounds, EdgeChain, Part, ThermalModel, Vec3 } from '../core/types';
import { metresPerUnit } from '../core/units';
import type { ImportedMesh } from './importers';
import {
  buildEdgeAdjacency,
  connectedComponents,
  DEFAULT_FEATURE_ANGLE_DEG,
  faceRegions,
  featureEdgeChains,
} from './topology';

export interface BuildOptions {
  /** Weld tolerance as a fraction of the model's bbox diagonal. */
  weldToleranceRatio?: number;
  /** Dihedral threshold for face regions and feature edges, degrees. */
  featureAngleDeg?: number;
  /** thinnessRatio below this guesses 'sheet', above it 'lump'. */
  sheetThinnessThreshold?: number;
  /**
   * Metres. Overrides the thickness `sheetThicknessOf` reads off each closed
   * solid, and is what open shells fall back to. Default DEFAULT_SHEET_THICKNESS.
   */
  defaultThickness?: number;
  defaultMaterialId?: string;
  defaultFinishId?: string;
}

export const DEFAULT_WELD_TOLERANCE_RATIO = 1e-6;

/**
 * A cube scores 0.58 and a 100×100×1 plate 0.02, so the boundary sits in a wide
 * empty gap. 0.3 lands roughly at a 10×10×2.5 block — about where "sheet with a
 * thickness" stops describing the part. The guess is shown and overridable.
 */
export const DEFAULT_SHEET_THINNESS_THRESHOLD = 0.3;

/** Metres. Only used where the mesh itself cannot say — an open shell has no volume to read. */
export const DEFAULT_SHEET_THICKNESS = 0.001;

/**
 * The sheet thickness a closed solid implies, metres, or 0 when it implies none.
 *
 * A CAD sheet-metal part is a solid, so its tessellation is a closed shell carrying
 * both faces of the sheet plus the edge bands: `volume ≈ A_mid·t` while
 * `surfaceArea ≈ 2·A_mid`, which leaves `t = 2·volume/surfaceArea`. On the TBTE
 * assembly that recovers 0.98–0.99 mm for the three parts drawn from 1 mm sheet —
 * better than any default the user could be asked to guess.
 */
function sheetThicknessOf(volume: number, surfaceArea: number): number {
  if (!(surfaceArea > 0)) return 0;
  return (2 * Math.abs(volume)) / surfaceArea;
}

export function buildThermalModel(mesh: ImportedMesh, options: BuildOptions = {}): ThermalModel {
  const featureAngleDeg = options.featureAngleDeg ?? DEFAULT_FEATURE_ANGLE_DEG;
  const sheetThreshold = options.sheetThinnessThreshold ?? DEFAULT_SHEET_THINNESS_THRESHOLD;

  const scale = metresPerUnit(mesh.units);
  const rawPositions = new Float64Array(mesh.positions.length);
  for (let i = 0; i < rawPositions.length; i++) rawPositions[i] = mesh.positions[i] * scale;

  const modelBounds = boundsOf(rawPositions, rawPositions.length / 3, (n) => n);
  const diagonal = diagonalOf(modelBounds);
  const tolerance = diagonal * (options.weldToleranceRatio ?? DEFAULT_WELD_TOLERANCE_RATIO);

  // With no part structure the whole soup welds as one group, then connected
  // components split it; welding per provisional part first would fuse nothing.
  const weldGroup = mesh.derivePartsFromComponents
    ? new Uint32Array(mesh.triPart.length)
    : mesh.triPart;
  const welded = weldVertices(rawPositions, mesh.indices, weldGroup, tolerance);

  const kept = keepNonDegenerate(welded.tris, mesh.triPart, mesh.triFace);
  const triPart = mesh.derivePartsFromComponents
    ? connectedComponents(kept.tris, welded.positions.length / 3).triComponent
    : kept.triPart;
  const partNames = mesh.derivePartsFromComponents
    ? componentNames(triPart, mesh.partNames[0] ?? 'part')
    : mesh.partNames;

  let partCount = partNames.length;
  for (const part of triPart) partCount = Math.max(partCount, part + 1);
  const ordered = orderByPart(welded.positions, kept.tris, triPart, kept.triFace, partCount);

  const triCount = ordered.tris.length / 3;
  const nodeCount = ordered.positions.length / 3;
  const nodes = Float32Array.from(ordered.positions);
  const triArea = new Float32Array(triCount);
  const triNormal = new Float32Array(triCount * 3);
  const nodeArea = new Float32Array(nodeCount);
  for (let t = 0; t < triCount; t++) {
    const geometry = triangleGeometry(ordered.positions, ordered.tris, t);
    triArea[t] = geometry.area;
    triNormal[t * 3] = geometry.normal[0];
    triNormal[t * 3 + 1] = geometry.normal[1];
    triNormal[t * 3 + 2] = geometry.normal[2];
    for (let c = 0; c < 3; c++) nodeArea[ordered.tris[t * 3 + c]] += geometry.area / 3;
  }

  const triFace = ordered.triFace
    ? denseFaceIds(ordered.triFace, ordered.triPart)
    : faceRegions(ordered.tris, nodeCount, triNormal, featureAngleDeg).triFace;

  const featureEdges: EdgeChain[] = featureEdgeChains(
    ordered.tris,
    nodeCount,
    triNormal,
    ordered.triPart,
    featureAngleDeg,
  );

  const parts = buildParts({
    partNames,
    triRanges: ordered.triRanges,
    nodeRanges: ordered.nodeRanges,
    positions: ordered.positions,
    tris: ordered.tris,
    triArea,
    nodeCount,
    sheetThreshold,
    thicknessOverride: options.defaultThickness,
    materialId: options.defaultMaterialId ?? 'ss304',
    finishId: options.defaultFinishId ?? 'bare-metal',
  });

  return {
    nodes,
    tris: ordered.tris,
    triPart: ordered.triPart,
    triFace,
    triArea,
    triNormal,
    triCavity: new Uint8Array(triCount),
    nodePart: ordered.nodePart,
    nodeArea,
    parts,
    featureEdges,
    bbox: boundsOf(ordered.positions, nodeCount, (n) => n),
    sourceUnits: mesh.units,
    nodeCount,
    triCount,
  };
}

// ---------------------------------------------------------------------------
// Welding
// ---------------------------------------------------------------------------

interface WeldResult {
  positions: Float64Array;
  tris: Uint32Array;
}

/**
 * Merges coincident vertices within each group via a spatial hash, checking the
 * 27 cells around a vertex so a pair straddling a cell boundary still welds.
 * Groups are parts: welding across parts would silently give every touching pair
 * of parts perfect thermal contact, which is exactly what `Contact` exists to
 * make explicit and finite.
 */
function weldVertices(
  positions: Float64Array,
  indices: Uint32Array,
  triGroup: Uint32Array,
  tolerance: number,
): WeldResult {
  const cell = tolerance > 0 ? tolerance : Number.EPSILON;
  const toleranceSquared = tolerance * tolerance;
  const representativeOf = new Int32Array(positions.length / 3).fill(-1);
  const buckets = new Map<number, number[]>();
  const repPositions: number[] = [];
  const repGroup: number[] = [];

  for (let corner = 0; corner < indices.length; corner++) {
    const vertex = indices[corner];
    if (representativeOf[vertex] >= 0) continue;
    const group = triGroup[Math.floor(corner / 3)];
    const x = positions[vertex * 3];
    const y = positions[vertex * 3 + 1];
    const z = positions[vertex * 3 + 2];
    const ix = Math.floor(x / cell);
    const iy = Math.floor(y / cell);
    const iz = Math.floor(z / cell);

    let match = -1;
    for (let dx = -1; dx <= 1 && match < 0; dx++) {
      for (let dy = -1; dy <= 1 && match < 0; dy++) {
        for (let dz = -1; dz <= 1 && match < 0; dz++) {
          const bucket = buckets.get(cellHash(group, ix + dx, iy + dy, iz + dz));
          if (!bucket) continue;
          for (const candidate of bucket) {
            if (repGroup[candidate] !== group) continue;
            const ddx = repPositions[candidate * 3] - x;
            const ddy = repPositions[candidate * 3 + 1] - y;
            const ddz = repPositions[candidate * 3 + 2] - z;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= toleranceSquared) {
              match = candidate;
              break;
            }
          }
        }
      }
    }

    if (match >= 0) {
      representativeOf[vertex] = match;
      continue;
    }
    const created = repGroup.length;
    repPositions.push(x, y, z);
    repGroup.push(group);
    const key = cellHash(group, ix, iy, iz);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(created);
    else buckets.set(key, [created]);
    representativeOf[vertex] = created;
  }

  const tris = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) tris[i] = representativeOf[indices[i]];
  return { positions: Float64Array.from(repPositions), tris };
}

function cellHash(group: number, ix: number, iy: number, iz: number): number {
  let hash = Math.imul(group + 1, 0x27d4eb2d);
  hash = (hash ^ Math.imul(ix, 0x9e3779b1)) >>> 0;
  hash = (hash ^ Math.imul(iy, 0x85ebca6b)) >>> 0;
  hash = (hash ^ Math.imul(iz, 0xc2b2ae35)) >>> 0;
  return hash >>> 0;
}

/** Welding collapses slivers into degenerate triangles; they carry no area and break adjacency. */
function keepNonDegenerate(
  tris: Uint32Array,
  triPart: Uint32Array,
  triFace: Uint32Array | null,
): { tris: Uint32Array; triPart: Uint32Array; triFace: Uint32Array | null } {
  const survivors: number[] = [];
  for (let t = 0; t < tris.length / 3; t++) {
    const a = tris[t * 3];
    const b = tris[t * 3 + 1];
    const c = tris[t * 3 + 2];
    if (a !== b && b !== c && a !== c) survivors.push(t);
  }
  if (survivors.length === tris.length / 3) return { tris, triPart, triFace };

  const keptTris = new Uint32Array(survivors.length * 3);
  const keptPart = new Uint32Array(survivors.length);
  const keptFace = triFace ? new Uint32Array(survivors.length) : null;
  survivors.forEach((t, i) => {
    keptTris[i * 3] = tris[t * 3];
    keptTris[i * 3 + 1] = tris[t * 3 + 1];
    keptTris[i * 3 + 2] = tris[t * 3 + 2];
    keptPart[i] = triPart[t];
    if (keptFace && triFace) keptFace[i] = triFace[t];
  });
  return { tris: keptTris, triPart: keptPart, triFace: keptFace };
}

function componentNames(triComponent: Uint32Array, baseName: string): string[] {
  let count = 0;
  for (const component of triComponent) count = Math.max(count, component + 1);
  if (count <= 1) return [baseName];
  return Array.from({ length: count }, (_, i) => `${baseName} ${i + 1}`);
}

// ---------------------------------------------------------------------------
// Contiguous part ranges
// ---------------------------------------------------------------------------

interface OrderedMesh {
  positions: Float64Array;
  tris: Uint32Array;
  triPart: Uint32Array;
  triFace: Uint32Array | null;
  nodePart: Uint32Array;
  triRanges: Array<readonly [number, number]>;
  nodeRanges: Array<readonly [number, number]>;
}

/** `Part` addresses its triangles and nodes as half-open ranges, so both must be sorted by part. */
function orderByPart(
  positions: Float64Array,
  tris: Uint32Array,
  triPart: Uint32Array,
  triFace: Uint32Array | null,
  partCount: number,
): OrderedMesh {
  const triCount = tris.length / 3;
  const partOfNode = new Int32Array(positions.length / 3).fill(-1);
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const node = tris[t * 3 + c];
      if (partOfNode[node] < 0) partOfNode[node] = triPart[t];
    }
  }

  const nodeRanges = rangesByPart(partOfNode, partCount);
  const nodeCursor = nodeRanges.map(([start]) => start);
  const nodeRemap = new Int32Array(partOfNode.length).fill(-1);
  const nodeOrder = new Uint32Array(nodeRanges[partCount - 1]?.[1] ?? 0);
  for (let node = 0; node < partOfNode.length; node++) {
    const part = partOfNode[node];
    if (part < 0) continue;
    const slot = nodeCursor[part]++;
    nodeRemap[node] = slot;
    nodeOrder[slot] = node;
  }

  const triRanges = rangesByPart(triPart, partCount);
  const triCursor = triRanges.map(([start]) => start);

  const outPositions = new Float64Array(nodeOrder.length * 3);
  const outNodePart = new Uint32Array(nodeOrder.length);
  for (let n = 0; n < nodeOrder.length; n++) {
    const node = nodeOrder[n];
    outPositions[n * 3] = positions[node * 3];
    outPositions[n * 3 + 1] = positions[node * 3 + 1];
    outPositions[n * 3 + 2] = positions[node * 3 + 2];
    outNodePart[n] = partOfNode[node];
  }

  const outTris = new Uint32Array(triCount * 3);
  const outTriPart = new Uint32Array(triCount);
  const outTriFace = triFace ? new Uint32Array(triCount) : null;
  for (let t = 0; t < triCount; t++) {
    const slot = triCursor[triPart[t]]++;
    for (let c = 0; c < 3; c++) outTris[slot * 3 + c] = nodeRemap[tris[t * 3 + c]];
    outTriPart[slot] = triPart[t];
    if (outTriFace && triFace) outTriFace[slot] = triFace[t];
  }

  return {
    positions: outPositions,
    tris: outTris,
    triPart: outTriPart,
    triFace: outTriFace,
    nodePart: outNodePart,
    triRanges,
    nodeRanges,
  };
}

function rangesByPart(
  partOf: Int32Array | Uint32Array,
  partCount: number,
): Array<readonly [number, number]> {
  const counts = new Uint32Array(partCount);
  for (const part of partOf) if (part >= 0) counts[part]++;
  const ranges: Array<readonly [number, number]> = [];
  let start = 0;
  for (let part = 0; part < partCount; part++) {
    ranges.push([start, start + counts[part]]);
    start += counts[part];
  }
  return ranges;
}

/** Source face ids are sparse and only unique within a part; make them dense and model-wide. */
function denseFaceIds(triFace: Uint32Array, triPart: Uint32Array): Uint32Array {
  const dense = new Uint32Array(triFace.length);
  const idByKey = new Map<string, number>();
  for (let t = 0; t < triFace.length; t++) {
    const key = `${triPart[t]}:${triFace[t]}`;
    let id = idByKey.get(key);
    if (id === undefined) {
      id = idByKey.size;
      idByKey.set(key, id);
    }
    dense[t] = id;
  }
  return dense;
}

// ---------------------------------------------------------------------------
// Part properties
// ---------------------------------------------------------------------------

interface PartInputs {
  partNames: string[];
  triRanges: Array<readonly [number, number]>;
  nodeRanges: Array<readonly [number, number]>;
  positions: Float64Array;
  tris: Uint32Array;
  triArea: Float32Array;
  nodeCount: number;
  sheetThreshold: number;
  /** Set only when the caller asked for one thickness everywhere. */
  thicknessOverride: number | undefined;
  materialId: string;
  finishId: string;
}

function buildParts(inputs: PartInputs): Part[] {
  const parts: Part[] = [];
  for (let p = 0; p < inputs.triRanges.length; p++) {
    const [triStart, triEnd] = inputs.triRanges[p];
    const [nodeStart, nodeEnd] = inputs.nodeRanges[p];
    const name = inputs.partNames[p] ?? `part ${p + 1}`;

    let surfaceArea = 0;
    for (let t = triStart; t < triEnd; t++) surfaceArea += inputs.triArea[t];

    const bbox = boundsOf(inputs.positions, nodeEnd - nodeStart, (n) => n + nodeStart);
    const diagonal = diagonalOf(bbox);
    const volume = shellVolume(inputs.positions, inputs.tris, triStart, triEnd, inputs.nodeCount);
    const thinnessRatio =
      surfaceArea > 0 && diagonal > 0 ? (6 * Math.abs(volume)) / (surfaceArea * diagonal) : 0;
    const impliedThickness = sheetThicknessOf(volume, surfaceArea);

    parts.push({
      id: `${slugify(name)}-${p}`,
      name,
      // 'insulator' is never guessed: excluding a part from the solve is a
      // decision only the user can make.
      bodyType: thinnessRatio < inputs.sheetThreshold ? 'sheet' : 'lump',
      materialId: inputs.materialId,
      finishId: inputs.finishId,
      thickness:
        inputs.thicknessOverride ??
        (impliedThickness > 0 ? impliedThickness : DEFAULT_SHEET_THICKNESS),
      triRange: [triStart, triEnd],
      nodeRange: [nodeStart, nodeEnd],
      volume,
      surfaceArea,
      thinnessRatio,
      bbox,
    });
  }
  return parts;
}

/** Divergence theorem over the part's triangles. Open shells have no volume, so report 0. */
function shellVolume(
  positions: Float64Array,
  tris: Uint32Array,
  triStart: number,
  triEnd: number,
  nodeCount: number,
): number {
  const partTris = tris.subarray(triStart * 3, triEnd * 3);
  const adjacency = buildEdgeAdjacency(partTris, nodeCount);
  for (let edge = 0; edge < adjacency.edgeCount; edge++) {
    if (adjacency.edgeUseCount[edge] !== 2) return 0;
  }

  let sum = 0;
  for (let t = 0; t < partTris.length / 3; t++) {
    const a = partTris[t * 3] * 3;
    const b = partTris[t * 3 + 1] * 3;
    const c = partTris[t * 3 + 2] * 3;
    sum +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) +
      positions[a + 1] * (positions[b + 2] * positions[c] - positions[b] * positions[c + 2]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return sum / 6;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function triangleGeometry(
  positions: Float64Array,
  tris: Uint32Array,
  t: number,
): { area: number; normal: Vec3 } {
  const a = tris[t * 3] * 3;
  const b = tris[t * 3 + 1] * 3;
  const c = tris[t * 3 + 2] * 3;
  const e1x = positions[b] - positions[a];
  const e1y = positions[b + 1] - positions[a + 1];
  const e1z = positions[b + 2] - positions[a + 2];
  const e2x = positions[c] - positions[a];
  const e2y = positions[c + 1] - positions[a + 1];
  const e2z = positions[c + 2] - positions[a + 2];
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const length = Math.hypot(nx, ny, nz);
  if (length === 0) return { area: 0, normal: [0, 0, 1] };
  return { area: length / 2, normal: [nx / length, ny / length, nz / length] };
}

function boundsOf(positions: Float64Array, count: number, nodeAt: (n: number) => number): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let n = 0; n < count; n++) {
    const node = nodeAt(n);
    for (let k = 0; k < 3; k++) {
      const value = positions[node * 3 + k];
      if (value < min[k]) min[k] = value;
      if (value > max[k]) max[k] = value;
    }
  }
  if (count === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

function diagonalOf(bounds: Bounds): number {
  return Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'part';
}
