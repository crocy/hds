/**
 * The material library as the UI sees it: the seed library plus whatever the user
 * typed in by hand.
 *
 * A `PartOverride` carries only a material id, and `physics/materials` throws rather
 * than substituting a default for an id it does not know — deliberately, since a
 * silent swap would change the answer. So a custom material has to be *registered*
 * in every context that resolves a scenario: here on the main thread, and again in
 * the solve worker from the copies that travel with the request.
 */

import type { Material, PartOverride, SurfaceFinish } from '@/core/types';
import {
  findFinish,
  findMaterial,
  listFinishes,
  listMaterials,
  registerFinish,
  registerMaterial,
} from '@/physics/materials';

export interface CustomLibrary {
  materials: Material[];
  finishes: SurfaceFinish[];
}

export const EMPTY_CUSTOM_LIBRARY: CustomLibrary = { materials: [], finishes: [] };

/** Idempotent: re-registering an id replaces the entry, which is what an edit is. */
export function registerCustomLibrary(library: CustomLibrary): void {
  for (const material of library.materials) registerMaterial(material);
  for (const finish of library.finishes) registerFinish(finish);
}

export function allMaterials(custom: CustomLibrary): Material[] {
  return [...listMaterials(), ...custom.materials];
}

export function allFinishes(custom: CustomLibrary): SurfaceFinish[] {
  return [...listFinishes(), ...custom.finishes];
}

export function upsertMaterial(library: CustomLibrary, material: Material): CustomLibrary {
  registerMaterial(material);
  const materials = library.materials.some((existing) => existing.id === material.id)
    ? library.materials.map((existing) => (existing.id === material.id ? material : existing))
    : [...library.materials, material];
  return { ...library, materials };
}

export function upsertFinish(library: CustomLibrary, finish: SurfaceFinish): CustomLibrary {
  registerFinish(finish);
  const finishes = library.finishes.some((existing) => existing.id === finish.id)
    ? library.finishes.map((existing) => (existing.id === finish.id ? finish : existing))
    : [...library.finishes, finish];
  return { ...library, finishes };
}

/**
 * The material a part will actually be solved with, or a clearly-labelled stand-in
 * when the id resolves to nothing. The UI must render a broken scenario rather than
 * throw on it; the solve is where an unknown id has to be fatal.
 */
export function describeMaterial(id: string): Material {
  return (
    findMaterial(id) ?? { id, name: `${id} (missing)`, k: Number.NaN, category: 'custom' as const }
  );
}

export function describeFinish(id: string): SurfaceFinish {
  return findFinish(id) ?? { id, name: `${id} (missing)`, emissivity: Number.NaN };
}

/** Ids referenced by the scenario that no material or finish resolves. */
export function missingLibraryIds(
  partOverrides: Record<string, PartOverride>,
  partDefaults: ReadonlyArray<{ materialId: string; finishId: string }>,
): string[] {
  const missing = new Set<string>();
  for (const part of partDefaults) {
    if (!findMaterial(part.materialId)) missing.add(part.materialId);
    if (!findFinish(part.finishId)) missing.add(part.finishId);
  }
  for (const override of Object.values(partOverrides)) {
    if (override.materialId && !findMaterial(override.materialId)) missing.add(override.materialId);
    if (override.finishId && !findFinish(override.finishId)) missing.add(override.finishId);
  }
  return [...missing];
}
