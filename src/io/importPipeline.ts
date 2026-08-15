/**
 * CAD file → `ThermalModel` + the cavities and contacts the scenario starts with.
 *
 * One function, run either in `importWorker` or — when a Worker cannot be created —
 * on the main thread. Tessellating a STEP assembly and firing 32 rays per triangle
 * takes seconds, so the stage callback is what the progress overlay reports.
 */

import type { Cavity, Contact, ThermalModel } from '@/core/types';
import type { LengthUnit } from '@/core/units';
import { buildBvh } from '@/geometry/bvh';
import { buildThermalModel } from '@/geometry/build';
import { detectCavities } from '@/geometry/cavity';
import { DEFAULT_CONTACT_TOLERANCE, detectContacts } from '@/geometry/contacts';
import { formatFromFilename, importMesh } from '@/geometry/importers';

export type TessellationQuality = 'coarse' | 'normal' | 'fine';

export interface TessellationPreset {
  /** OCCT linear deflection as a fraction of the bounding box. */
  linearDeflection: number;
  /** Degrees. */
  angularDeflection: number;
}

/**
 * Chord error as a fraction of the assembly's bounding box. `normal` is OCCT's own
 * default; `fine` roughly quadruples the triangle count and is what a small feature
 * needs before its temperature means anything.
 */
export const TESSELLATION_PRESETS: Record<TessellationQuality, TessellationPreset> = {
  coarse: { linearDeflection: 0.004, angularDeflection: 0.6 },
  normal: { linearDeflection: 0.001, angularDeflection: 0.4 },
  fine: { linearDeflection: 0.00025, angularDeflection: 0.25 },
};

export interface ImportSettings {
  /** Only consulted for formats that carry no units; STEP is read as millimetres. */
  units: LengthUnit;
  quality: TessellationQuality;
  detectCavities: boolean;
  detectContacts: boolean;
  /** Metres. Surfaces closer than this pair up. */
  contactTolerance: number;
}

export const DEFAULT_IMPORT_SETTINGS: ImportSettings = {
  units: 'mm',
  quality: 'normal',
  detectCavities: true,
  detectContacts: true,
  contactTolerance: DEFAULT_CONTACT_TOLERANCE,
};

export type ImportStage =
  'reading' | 'tessellating' | 'building' | 'cavities' | 'contacts' | 'done';

export const IMPORT_STAGE_LABELS: Record<ImportStage, string> = {
  reading: 'reading file',
  tessellating: 'tessellating (loading the CAD kernel can take a few seconds)',
  building: 'welding vertices and deriving parts',
  cavities: 'detecting enclosed cavities',
  contacts: 'detecting contacts between parts',
  done: 'done',
};

export interface ImportProduct {
  model: ThermalModel;
  cavities: Cavity[];
  contacts: Contact[];
}

export type ImportProgress = (stage: ImportStage) => void;

export async function runImportPipeline(
  filename: string,
  data: ArrayBuffer,
  settings: ImportSettings,
  onProgress: ImportProgress = () => {},
): Promise<ImportProduct> {
  const format = formatFromFilename(filename);
  if (!format) {
    throw new Error(
      `'${filename}' is not a format HDS can read. Supported: .step, .stp, .stl, .obj`,
    );
  }

  const preset = TESSELLATION_PRESETS[settings.quality] ?? TESSELLATION_PRESETS.normal;
  onProgress('tessellating');
  const mesh = await importMesh(filename, data, {
    step: {
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: preset.linearDeflection,
      angularDeflection: preset.angularDeflection,
    },
    stl: { units: settings.units },
    obj: { units: settings.units },
  }).catch((error: unknown) => {
    throw new Error(`Could not read '${filename}': ${messageOf(error)}`);
  });

  if (mesh.indices.length === 0) {
    throw new Error(`'${filename}' contains no triangles`);
  }

  onProgress('building');
  const model = buildThermalModel(mesh);
  if (model.triCount === 0) {
    throw new Error(`'${filename}' produced no usable triangles after welding`);
  }

  // Both detections raycast the same geometry; one BVH serves them both.
  const needsBvh = settings.detectCavities || settings.detectContacts;
  const bvh = needsBvh ? buildBvh(model) : undefined;

  let cavities: Cavity[] = [];
  if (settings.detectCavities) {
    onProgress('cavities');
    cavities = detectCavities(model, { bvh }).cavities;
  }

  let contacts: Contact[] = [];
  if (settings.detectContacts) {
    onProgress('contacts');
    contacts = detectContacts(model, { bvh, tolerance: settings.contactTolerance });
  }

  onProgress('done');
  return { model, cavities, contacts };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
