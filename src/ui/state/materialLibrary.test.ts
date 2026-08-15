import { describe, expect, it } from 'vitest';
import { getFinish, getMaterial } from '@/physics/materials';
import { createCustomFinish, createCustomMaterial } from './entityFactories';
import {
  EMPTY_CUSTOM_LIBRARY,
  allMaterials,
  describeMaterial,
  missingLibraryIds,
  registerCustomLibrary,
  upsertFinish,
  upsertMaterial,
} from './materialLibrary';

describe('custom material library', () => {
  it('makes a hand-entered material resolvable by the same lookup the solver uses', () => {
    const material = createCustomMaterial('Sintered widget', 3.5);
    const library = upsertMaterial(EMPTY_CUSTOM_LIBRARY, material);

    expect(getMaterial(material.id).k).toBe(3.5);
    expect(allMaterials(library)).toContainEqual(material);
  });

  it('replaces an entry when the same id is registered again', () => {
    const material = createCustomMaterial('Editable', 1);
    const first = upsertMaterial(EMPTY_CUSTOM_LIBRARY, material);
    const second = upsertMaterial(first, { ...material, k: 9 });

    expect(second.materials).toHaveLength(1);
    expect(getMaterial(material.id).k).toBe(9);
  });

  it('refuses to shadow a library id', () => {
    expect(() =>
      upsertMaterial(EMPTY_CUSTOM_LIBRARY, { ...createCustomMaterial('fake', 1), id: 'ss304' }),
    ).toThrow(/library material/);
  });

  it('registers a whole library, as the worker does on every request', () => {
    const material = createCustomMaterial('Worker side', 7);
    const finish = createCustomFinish('Worker coat', 0.33);
    registerCustomLibrary({ materials: [material], finishes: [finish] });

    expect(getMaterial(material.id).k).toBe(7);
    expect(getFinish(finish.id).emissivity).toBe(0.33);
  });

  it('names an unresolvable id instead of throwing while rendering', () => {
    expect(describeMaterial('not-a-material').name).toMatch(/missing/);
    expect(
      missingLibraryIds({ 'part-0': { materialId: 'nope' } }, [
        { materialId: 'ss304', finishId: 'painted' },
      ]),
    ).toEqual(['nope']);
  });

  it('keeps a custom finish through an upsert', () => {
    const finish = createCustomFinish('Matte anodised', 0.8);
    const library = upsertFinish(EMPTY_CUSTOM_LIBRARY, finish);
    expect(library.finishes).toEqual([finish]);
    expect(getFinish(finish.id).emissivity).toBe(0.8);
  });
});
