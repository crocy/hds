/**
 * STEP via `occt-import-js` (OpenCascade compiled to wasm).
 *
 * Verified against the real TBTE assembly: the result is
 * `{ success, root, meshes }`, each mesh carries `name`, `attributes.position`,
 * `index` and — confirmed present, so no dihedral fallback is needed for STEP —
 * `brep_faces` as inclusive `{ first, last }` triangle ranges.
 */

import type { LengthUnit } from '../../core/units';
import type { ImportedMesh } from './index';

export interface OcctBrepFace {
  /** First triangle of the face, inclusive. */
  first: number;
  /** Last triangle of the face, inclusive. */
  last: number;
  color: [number, number, number] | null;
}

export interface OcctMesh {
  name: string;
  color?: [number, number, number];
  attributes: { position: { array: number[] }; normal?: { array: number[] } };
  index: { array: number[] };
  brep_faces?: OcctBrepFace[];
}

export interface OcctNode {
  name: string;
  meshes: number[];
  children: OcctNode[];
}

export interface OcctResult {
  success: boolean;
  root: OcctNode;
  meshes: OcctMesh[];
}

export interface OcctReadParams {
  linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot';
  linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value';
  linearDeflection?: number;
  angularDeflection?: number;
}

export interface OcctModule {
  ReadStepFile(content: Uint8Array, params: OcctReadParams | null): OcctResult;
}

export interface OcctModuleOverrides {
  /** Resolves 'occt-import-js.wasm' to a fetchable URL or filesystem path. */
  locateFile?: (file: string) => string;
}

export type OcctFactory = (overrides?: OcctModuleOverrides) => Promise<OcctModule>;

export interface StepImportOptions {
  /** Ratio of the average bounding box, or an absolute length in `linearDeflectionType`'s unit. */
  linearDeflection?: number;
  linearDeflectionType?: OcctReadParams['linearDeflectionType'];
  angularDeflection?: number;
  /** Defaults to `/occt-import-js.wasm`, i.e. the copy in `public/`. */
  locateFile?: (file: string) => string;
  /** Overrides how the wasm module is obtained. Node tests inject a resolved factory here. */
  loadOcct?: () => Promise<OcctFactory>;
  /** An already-instantiated module. Reuse it to avoid re-loading 7 MB of wasm per file. */
  occt?: OcctModule;
}

/**
 * OCCT is asked for millimetres regardless of what the file declares, so the
 * intermediate always reports a unit `build.ts` can trust.
 */
const OCCT_LINEAR_UNIT = 'millimeter';
const SOURCE_UNITS: LengthUnit = 'mm';

export async function createOcctModule(options: StepImportOptions = {}): Promise<OcctModule> {
  const factory = await (options.loadOcct ?? loadOcctFromPackage)();
  return factory({ locateFile: options.locateFile ?? ((file) => `/${file}`) });
}

export async function importStep(
  data: ArrayBuffer | Uint8Array,
  options: StepImportOptions = {},
): Promise<ImportedMesh> {
  const occt = options.occt ?? (await createOcctModule(options));
  const content = data instanceof Uint8Array ? data : new Uint8Array(data);

  const params: OcctReadParams = { linearUnit: OCCT_LINEAR_UNIT };
  if (options.linearDeflection !== undefined) params.linearDeflection = options.linearDeflection;
  if (options.linearDeflectionType !== undefined) {
    params.linearDeflectionType = options.linearDeflectionType;
  }
  if (options.angularDeflection !== undefined) params.angularDeflection = options.angularDeflection;

  const result = occt.ReadStepFile(content, params);
  if (!result.success) throw new Error('occt-import-js could not read the STEP file');

  return toImportedMesh(result);
}

function toImportedMesh(result: OcctResult): ImportedMesh {
  const namesByMesh = namesFromHierarchy(result.root, result.meshes.length);
  const positions: number[] = [];
  const indices: number[] = [];
  const triPart: number[] = [];
  const partNames: string[] = [];
  // A single mesh without brep_faces would leave part of the model with no face
  // structure, so the whole model falls back to dihedral regions rather than mixing.
  const hasBrepFaces = result.meshes.every((mesh) => (mesh.brep_faces?.length ?? 0) > 0);
  const triFace: number[] = [];
  let faceIdBase = 0;

  result.meshes.forEach((mesh, meshIndex) => {
    const partIndex = partNames.length;
    partNames.push(namesByMesh[meshIndex] || mesh.name || `part ${partIndex + 1}`);

    const base = positions.length / 3;
    // Appended one by one: a spread of a fine tessellation overflows the argument limit.
    for (const coordinate of mesh.attributes.position.array) positions.push(coordinate);
    const meshTriCount = Math.floor(mesh.index.array.length / 3);
    for (let t = 0; t < meshTriCount; t++) {
      indices.push(
        base + mesh.index.array[t * 3],
        base + mesh.index.array[t * 3 + 1],
        base + mesh.index.array[t * 3 + 2],
      );
      triPart.push(partIndex);
    }

    if (!hasBrepFaces) return;
    const faces = mesh.brep_faces ?? [];
    const localFace = new Uint32Array(meshTriCount);
    faces.forEach((face, faceIndex) => {
      for (let t = face.first; t <= face.last && t < meshTriCount; t++) {
        localFace[t] = faceIdBase + faceIndex;
      }
    });
    for (let t = 0; t < meshTriCount; t++) triFace.push(localFace[t]);
    faceIdBase += faces.length;
  });

  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    triPart: Uint32Array.from(triPart),
    triFace: hasBrepFaces ? Uint32Array.from(triFace) : null,
    partNames,
    units: SOURCE_UNITS,
    derivePartsFromComponents: false,
  };
}

/** Assembly node names are the ones a user recognises; mesh names are the fallback. */
function namesFromHierarchy(root: OcctNode, meshCount: number): string[] {
  const names = new Array<string>(meshCount).fill('');
  const visit = (node: OcctNode) => {
    for (const meshIndex of node.meshes) {
      if (meshIndex < meshCount && names[meshIndex] === '') names[meshIndex] = node.name;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return names;
}

async function loadOcctFromPackage(): Promise<OcctFactory> {
  // @ts-expect-error occt-import-js ships no type declarations; OcctFactory pins the shape.
  const module = await import('occt-import-js');
  return (module.default ?? module) as OcctFactory;
}
