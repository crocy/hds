/**
 * Synthetic ThermalModels shared by every module's tests.
 *
 * These exist so the analytical benchmarks in the spec (1D fin, isothermal plate,
 * two-part contact) are built from one agreed set of primitives rather than each
 * module inventing its own slightly different plate.
 */

import type { Bounds, Part, ThermalModel, Vec3 } from './types';

interface RawMesh {
  positions: number[];
  indices: number[];
  partOf: number[];
  faceOf: number[];
}

function emptyMesh(): RawMesh {
  return { positions: [], indices: [], partOf: [], faceOf: [] };
}

/**
 * A flat rectangular plate in the XY plane at z = 0, split into a regular
 * triangulated grid. The workhorse for the fin and plate benchmarks.
 */
export function stripMesh(
  lengthX: number,
  widthY: number,
  nx: number,
  ny: number,
  partIndex = 0,
  faceIndex = 0,
  offset: Vec3 = [0, 0, 0],
): RawMesh {
  const mesh = emptyMesh();
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      mesh.positions.push(offset[0] + (i / nx) * lengthX, offset[1] + (j / ny) * widthY, offset[2]);
    }
  }
  const at = (i: number, j: number) => j * (nx + 1) + i;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      mesh.indices.push(at(i, j), at(i + 1, j), at(i + 1, j + 1));
      mesh.indices.push(at(i, j), at(i + 1, j + 1), at(i, j + 1));
      mesh.partOf.push(partIndex, partIndex);
      mesh.faceOf.push(faceIndex, faceIndex);
    }
  }
  return mesh;
}

/** An axis-aligned closed box shell — six faces, each with its own face index. */
export function boxMesh(size: Vec3, origin: Vec3 = [0, 0, 0], partIndex = 0): RawMesh {
  const mesh = emptyMesh();
  const [sx, sy, sz] = size;
  const [ox, oy, oz] = origin;
  const corners: Vec3[] = [
    [ox, oy, oz],
    [ox + sx, oy, oz],
    [ox + sx, oy + sy, oz],
    [ox, oy + sy, oz],
    [ox, oy, oz + sz],
    [ox + sx, oy, oz + sz],
    [ox + sx, oy + sy, oz + sz],
    [ox, oy + sy, oz + sz],
  ];
  // Outward-facing winding.
  const faces: Array<[number, number, number, number]> = [
    [0, 3, 2, 1], // -Z
    [4, 5, 6, 7], // +Z
    [0, 1, 5, 4], // -Y
    [2, 3, 7, 6], // +Y
    [0, 4, 7, 3], // -X
    [1, 2, 6, 5], // +X
  ];
  faces.forEach((quad, faceIndex) => {
    const base = mesh.positions.length / 3;
    for (const c of quad) mesh.positions.push(...corners[c]);
    mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    mesh.partOf.push(partIndex, partIndex);
    mesh.faceOf.push(faceIndex, faceIndex);
  });
  return mesh;
}

export function mergeMeshes(...meshes: RawMesh[]): RawMesh {
  const out = emptyMesh();
  for (const mesh of meshes) {
    const base = out.positions.length / 3;
    out.positions.push(...mesh.positions);
    for (const index of mesh.indices) out.indices.push(index + base);
    out.partOf.push(...mesh.partOf);
    out.faceOf.push(...mesh.faceOf);
  }
  return out;
}

export interface TestPartSpec {
  name?: string;
  materialId?: string;
  finishId?: string;
  thickness?: number;
  bodyType?: Part['bodyType'];
}

/**
 * Turns a RawMesh into a ThermalModel with derived areas, normals and nodeArea.
 * Vertices are used as given — this does NOT weld, so tests that care about
 * welding should build their duplicates deliberately and call the real
 * `geometry/build` welder instead.
 */
export function modelFromMesh(mesh: RawMesh, partSpecs: TestPartSpec[] = []): ThermalModel {
  const nodes = new Float32Array(mesh.positions);
  const tris = new Uint32Array(mesh.indices);
  const triCount = tris.length / 3;
  const nodeCount = nodes.length / 3;

  const triPart = new Uint32Array(mesh.partOf);
  const triFace = new Uint32Array(mesh.faceOf);
  const triArea = new Float32Array(triCount);
  const triNormal = new Float32Array(triCount * 3);
  const triCavity = new Uint8Array(triCount);
  const nodeArea = new Float32Array(nodeCount);
  const nodePart = new Uint32Array(nodeCount);

  for (let t = 0; t < triCount; t++) {
    const a = tris[t * 3] * 3;
    const b = tris[t * 3 + 1] * 3;
    const c = tris[t * 3 + 2] * 3;
    const e1 = [nodes[b] - nodes[a], nodes[b + 1] - nodes[a + 1], nodes[b + 2] - nodes[a + 2]];
    const e2 = [nodes[c] - nodes[a], nodes[c + 1] - nodes[a + 1], nodes[c + 2] - nodes[a + 2]];
    const cross = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const norm = Math.hypot(cross[0], cross[1], cross[2]);
    triArea[t] = norm / 2;
    triNormal[t * 3] = norm > 0 ? cross[0] / norm : 0;
    triNormal[t * 3 + 1] = norm > 0 ? cross[1] / norm : 0;
    triNormal[t * 3 + 2] = norm > 0 ? cross[2] / norm : 1;
    for (let k = 0; k < 3; k++) {
      const node = tris[t * 3 + k];
      nodeArea[node] += triArea[t] / 3;
      nodePart[node] = triPart[t];
    }
  }

  const partCount = Math.max(1, ...Array.from(triPart, (p) => p + 1));
  const parts: Part[] = [];
  for (let p = 0; p < partCount; p++) {
    const spec = partSpecs[p] ?? {};
    let triStart = -1;
    let triEnd = -1;
    for (let t = 0; t < triCount; t++) {
      if (triPart[t] !== p) continue;
      if (triStart < 0) triStart = t;
      triEnd = t + 1;
    }
    let nodeStart = -1;
    let nodeEnd = -1;
    for (let n = 0; n < nodeCount; n++) {
      if (nodePart[n] !== p) continue;
      if (nodeStart < 0) nodeStart = n;
      nodeEnd = n + 1;
    }
    let surfaceArea = 0;
    for (let t = triStart; t < triEnd; t++) if (triPart[t] === p) surfaceArea += triArea[t];
    parts.push({
      id: `part-${p}`,
      name: spec.name ?? `part ${p}`,
      bodyType: spec.bodyType ?? 'sheet',
      materialId: spec.materialId ?? 'ss304',
      finishId: spec.finishId ?? 'bare-metal',
      thickness: spec.thickness ?? 0.001,
      triRange: [Math.max(0, triStart), Math.max(0, triEnd)],
      nodeRange: [Math.max(0, nodeStart), Math.max(0, nodeEnd)],
      volume: 0,
      surfaceArea,
      thinnessRatio: 0,
      bbox: boundsOf(nodes, nodeStart, nodeEnd),
    });
  }

  return {
    nodes,
    tris,
    triPart,
    triFace,
    triArea,
    triNormal,
    triCavity,
    nodePart,
    nodeArea,
    parts,
    featureEdges: [],
    bbox: boundsOf(nodes, 0, nodeCount),
    sourceUnits: 'm',
    nodeCount,
    triCount,
  };
}

function boundsOf(nodes: Float32Array, start: number, end: number): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let n = Math.max(0, start); n < Math.max(0, end); n++) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], nodes[n * 3 + k]);
      max[k] = Math.max(max[k], nodes[n * 3 + k]);
    }
  }
  return { min, max };
}

/** A 1D fin: a long thin strip, meshed finely along its length. */
export function finModel(length = 0.3, width = 0.02, thickness = 0.001, nx = 300): ThermalModel {
  return modelFromMesh(stripMesh(length, width, nx, 1), [{ name: 'fin', thickness }]);
}

/** Two coplanar strips end to end as separate parts, for contact-conductance tests. */
export function twoStripModel(length = 0.1, width = 0.02, nx = 50): ThermalModel {
  return modelFromMesh(
    mergeMeshes(
      stripMesh(length, width, nx, 1, 0, 0),
      stripMesh(length, width, nx, 1, 1, 1, [length, 0, 0]),
    ),
    [{ name: 'left' }, { name: 'right' }],
  );
}
