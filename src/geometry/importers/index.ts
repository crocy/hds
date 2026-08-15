/**
 * The intermediate every importer produces, and the format dispatcher.
 *
 * Importers deliberately stop short of a `ThermalModel`: they hand back a raw,
 * unwelded triangle soup plus whatever part and face structure the source file
 * carried. `geometry/build.ts` owns welding, areas and part derivation, so that
 * work is written and tested once rather than three times.
 */

import type { LengthUnit } from '../../core/units';
import { importObj, type ObjImportOptions } from './obj';
import { importStep, type StepImportOptions } from './step';
import { importStl, type StlImportOptions } from './stl';

export interface ImportedMesh {
  /** xyz interleaved, in `units`. Not welded — vertices repeat at every seam. */
  positions: Float64Array;
  /** Triangle corners as indices into `positions`. length = 3 × triCount */
  indices: Uint32Array;
  /** Part index per triangle, indexing `partNames`. */
  triPart: Uint32Array;
  /** Face region index per triangle, or null when the format carries no faces. */
  triFace: Uint32Array | null;
  partNames: string[];
  units: LengthUnit;
  /**
   * The source has no part structure (STL). `partNames[0]` is then a base name
   * and `build.ts` derives the real parts from connected components.
   */
  derivePartsFromComponents: boolean;
}

export type ImportFormat = 'step' | 'stl' | 'obj';

const FORMAT_BY_EXTENSION: Record<string, ImportFormat> = {
  step: 'step',
  stp: 'step',
  stl: 'stl',
  obj: 'obj',
};

export function formatFromFilename(filename: string): ImportFormat | null {
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  return FORMAT_BY_EXTENSION[extension] ?? null;
}

export interface ImportOptions {
  step?: StepImportOptions;
  stl?: StlImportOptions;
  obj?: ObjImportOptions;
}

export async function importMesh(
  filename: string,
  data: ArrayBuffer | Uint8Array,
  options: ImportOptions = {},
): Promise<ImportedMesh> {
  const format = formatFromFilename(filename);
  switch (format) {
    case 'step':
      return importStep(data, options.step);
    case 'stl':
      return importStl(data, options.stl);
    case 'obj':
      return importObj(decodeText(data), options.obj);
    default:
      throw new Error(`Unsupported CAD format: ${filename}`);
  }
}

function decodeText(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new TextDecoder().decode(bytes);
}

export { importObj, importStep, importStl };
export { createOcctModule } from './step';
export type { ObjImportOptions, StepImportOptions, StlImportOptions };
