/**
 * Wavefront OBJ via three.js `OBJLoader`.
 *
 * `OBJLoader.parse` touches no DOM API, so it runs unchanged in Node tests. It
 * emits one non-indexed `Mesh` per `o`/`g` group — the duplication is harmless
 * because `build.ts` welds anyway, and the groups are exactly the part split we
 * want. OBJ carries no units; millimetres is the default assumption.
 */

import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import type { Mesh } from 'three';
import type { LengthUnit } from '../../core/units';
import type { ImportedMesh } from './index';

export interface ObjImportOptions {
  units?: LengthUnit;
}

export function importObj(text: string, options: ObjImportOptions = {}): ImportedMesh {
  const group = new OBJLoader().parse(text);
  const meshes = group.children.filter((child): child is Mesh => (child as Mesh).isMesh === true);

  const positions: number[] = [];
  const indices: number[] = [];
  const triPart: number[] = [];
  const partNames: string[] = [];

  for (const mesh of meshes) {
    const attribute = mesh.geometry.getAttribute('position');
    if (!attribute) continue;
    const base = positions.length / 3;
    const partIndex = partNames.length;
    partNames.push(mesh.name || `part ${partIndex + 1}`);

    for (let v = 0; v < attribute.count; v++) {
      positions.push(attribute.getX(v), attribute.getY(v), attribute.getZ(v));
    }
    const index = mesh.geometry.getIndex();
    const corners = index ? Array.from(index.array) : range(attribute.count);
    for (let i = 0; i + 2 < corners.length; i += 3) {
      indices.push(base + corners[i], base + corners[i + 1], base + corners[i + 2]);
      triPart.push(partIndex);
    }
  }

  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    triPart: Uint32Array.from(triPart),
    triFace: null,
    partNames: partNames.length > 0 ? partNames : ['part 1'],
    units: options.units ?? 'mm',
    derivePartsFromComponents: false,
  };
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}
