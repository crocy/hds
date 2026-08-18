/**
 * Seed library of bulk materials and surface finishes, plus the per-part property
 * resolver every other physics module goes through.
 *
 * Conductivities are room-temperature values from standard handbook tables
 * (Incropera Table A.1/A.3); they are a starting point a user can override, not a
 * claim of two-figure accuracy at 200 °C.
 *
 * Emissivity lives on the finish rather than the material on purpose: bare SS304 is
 * ≈0.15 and the same steel painted is ≈0.9, and on a hot part that difference
 * dominates the total loss.
 */

import type { BodyType, Material, Part, PartOverride, SurfaceFinish } from '../core/types';

export const DEFAULT_MATERIAL_ID = 'ss304';
export const DEFAULT_FINISH_ID = 'bare-metal';

export const MATERIALS: readonly Material[] = [
  {
    id: 'ss304',
    name: 'Stainless steel 304',
    k: 14.9,
    density: 7900,
    specificHeat: 477,
    category: 'metal',
  },
  {
    id: 'al6061',
    name: 'Aluminium 6061-T6',
    k: 167,
    density: 2700,
    specificHeat: 896,
    category: 'metal',
  },
  {
    id: 'copper',
    name: 'Copper (pure)',
    k: 400,
    density: 8933,
    specificHeat: 385,
    category: 'metal',
  },
  {
    id: 'mild-steel',
    name: 'Mild steel (AISI 1010)',
    k: 50,
    density: 7850,
    specificHeat: 470,
    category: 'metal',
  },
  { id: 'abs', name: 'ABS', k: 0.17, density: 1050, specificHeat: 1400, category: 'polymer' },
  {
    id: 'pc',
    name: 'Polycarbonate',
    k: 0.2,
    density: 1200,
    specificHeat: 1200,
    category: 'polymer',
  },
  { id: 'ptfe', name: 'PTFE', k: 0.25, density: 2200, specificHeat: 1050, category: 'polymer' },
  // FR4 is strongly anisotropic (≈0.8 in-plane, ≈0.3 through-thickness). The shell
  // solver conducts in-plane, so the in-plane figure is the honest default.
  {
    id: 'fr4',
    name: 'FR4 laminate',
    k: 0.8,
    density: 1900,
    specificHeat: 1200,
    category: 'ceramic',
  },
  {
    id: 'glass-wool',
    name: 'Glass wool',
    k: 0.04,
    density: 20,
    specificHeat: 840,
    category: 'insulation',
  },
  {
    id: 'ceramic-fibre',
    name: 'Ceramic fibre blanket',
    k: 0.06,
    density: 128,
    specificHeat: 1000,
    category: 'insulation',
  },
  {
    id: 'still-air',
    name: 'Still air',
    k: 0.026,
    density: 1.18,
    specificHeat: 1007,
    category: 'fluid',
  },
];

export const SURFACE_FINISHES: readonly SurfaceFinish[] = [
  { id: 'polished-metal', name: 'Polished metal', emissivity: 0.1 },
  { id: 'bare-metal', name: 'Bare / mill-finish metal', emissivity: 0.15 },
  { id: 'oxidised-metal', name: 'Oxidised metal', emissivity: 0.5 },
  { id: 'anodised', name: 'Anodised aluminium', emissivity: 0.85 },
  { id: 'painted', name: 'Painted', emissivity: 0.9 },
  { id: 'black-body', name: 'Matt black', emissivity: 0.95 },
  // A perfect reflector. Real surfaces are never this, but switching radiation off for
  // one part is how you reproduce a hand calculation or an analytic benchmark.
  { id: 'no-radiation', name: 'None (ε = 0)', emissivity: 0 },
];

const MATERIALS_BY_ID = new Map(MATERIALS.map((material) => [material.id, material]));
const FINISHES_BY_ID = new Map(SURFACE_FINISHES.map((finish) => [finish.id, finish]));

/**
 * User-defined materials and finishes, added at runtime by the UI.
 *
 * A `PartOverride` carries only an id, so every context that resolves a scenario has
 * to know the same custom entries — the main thread registers them on load, and the
 * solve worker registers the copies that travel with its request.
 */
const LIBRARY_MATERIAL_IDS: ReadonlySet<string> = new Set(MATERIALS.map((m) => m.id));
const LIBRARY_FINISH_IDS: ReadonlySet<string> = new Set(SURFACE_FINISHES.map((f) => f.id));

/** Registers a custom material, or replaces one registered earlier under the same id. */
export function registerMaterial(material: Material): void {
  if (LIBRARY_MATERIAL_IDS.has(material.id)) {
    throw new Error(`'${material.id}' is a library material and cannot be redefined`);
  }
  MATERIALS_BY_ID.set(material.id, material);
}

export function registerFinish(finish: SurfaceFinish): void {
  if (LIBRARY_FINISH_IDS.has(finish.id)) {
    throw new Error(`'${finish.id}' is a library finish and cannot be redefined`);
  }
  FINISHES_BY_ID.set(finish.id, finish);
}

export class UnknownMaterialError extends Error {
  constructor(readonly materialId: string) {
    super(
      `Unknown material id '${materialId}'. Known ids: ${[...MATERIALS_BY_ID.keys()].join(', ')}`,
    );
    this.name = 'UnknownMaterialError';
  }
}

export class UnknownFinishError extends Error {
  constructor(readonly finishId: string) {
    super(`Unknown finish id '${finishId}'. Known ids: ${[...FINISHES_BY_ID.keys()].join(', ')}`);
    this.name = 'UnknownFinishError';
  }
}

export function findMaterial(id: string): Material | undefined {
  return MATERIALS_BY_ID.get(id);
}

export function findFinish(id: string): SurfaceFinish | undefined {
  return FINISHES_BY_ID.get(id);
}

/** Throws rather than substituting a default — a silent swap would quietly change the answer. */
export function getMaterial(id: string): Material {
  const material = MATERIALS_BY_ID.get(id);
  if (!material) throw new UnknownMaterialError(id);
  return material;
}

export function getFinish(id: string): SurfaceFinish {
  const finish = FINISHES_BY_ID.get(id);
  if (!finish) throw new UnknownFinishError(id);
  return finish;
}

export function listMaterials(): Material[] {
  return [...MATERIALS];
}

export function listFinishes(): SurfaceFinish[] {
  return [...SURFACE_FINISHES];
}

export interface ResolvedPart {
  bodyType: BodyType;
  material: Material;
  finish: SurfaceFinish;
  /** Metres. */
  thickness: number;
}

/** Applies the scenario's per-part override on top of the imported part properties. */
export function resolvePart(part: Part, override?: PartOverride): ResolvedPart {
  return {
    bodyType: override?.bodyType ?? part.bodyType,
    material: getMaterial(override?.materialId ?? part.materialId),
    finish: getFinish(override?.finishId ?? part.finishId),
    thickness: Math.max(0, override?.thickness ?? part.thickness),
  };
}

/**
 * The conductance a slab of this part would offer through its thickness, W/(m²·K).
 *
 * `k / t` — the contact-conductance form of the layer's own resistance, for the joint
 * that stands in for a part the shell solver cannot put a gradient through. Zero when
 * the part has no thickness to resist with.
 */
export function throughThicknessConductance(part: Part, override?: PartOverride): number {
  const resolved = resolvePart(part, override);
  return resolved.thickness > 0 ? resolved.material.k / resolved.thickness : 0;
}
