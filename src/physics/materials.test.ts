/**
 * The material and finish library, and the per-part resolver.
 *
 * The point of these tests is that an unknown id fails loudly: silently substituting a
 * default would change the answer without changing the report.
 */

import { describe, expect, it } from 'vitest';
import type { Part } from '../core/types';
import {
  DEFAULT_FINISH_ID,
  DEFAULT_MATERIAL_ID,
  findFinish,
  findMaterial,
  getFinish,
  getMaterial,
  listFinishes,
  listMaterials,
  resolvePart,
  UnknownFinishError,
  UnknownMaterialError,
} from './materials';

function partWith(overrides: Partial<Part> = {}): Part {
  return {
    id: 'part-0',
    name: 'part 0',
    bodyType: 'sheet',
    materialId: DEFAULT_MATERIAL_ID,
    finishId: DEFAULT_FINISH_ID,
    thickness: 0.002,
    triRange: [0, 0],
    nodeRange: [0, 0],
    volume: 0,
    surfaceArea: 0,
    thinnessRatio: 0,
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    ...overrides,
  };
}

describe('library lookup', () => {
  it('resolves the seeded ids', () => {
    expect(getMaterial('ss304').k).toBeCloseTo(14.9, 9);
    expect(getMaterial('al6061').k).toBeCloseTo(167, 9);
    expect(getFinish('painted').emissivity).toBeCloseTo(0.9, 9);
    expect(getFinish('no-radiation').emissivity).toBe(0);
  });

  it('throws with the offending id and the known ones listed', () => {
    expect(() => getMaterial('unobtanium')).toThrow(UnknownMaterialError);
    expect(() => getMaterial('unobtanium')).toThrow(/unobtanium/);
    expect(() => getMaterial('unobtanium')).toThrow(/ss304/);
    expect(() => getFinish('chrome')).toThrow(UnknownFinishError);
    expect(() => getFinish('chrome')).toThrow(/chrome/);
    try {
      getMaterial('unobtanium');
    } catch (error) {
      expect((error as UnknownMaterialError).materialId).toBe('unobtanium');
      expect((error as Error).name).toBe('UnknownMaterialError');
    }
  });

  it('offers a non-throwing lookup for the id-validating paths', () => {
    expect(findMaterial('ss304')?.name).toBe('Stainless steel 304');
    expect(findMaterial('unobtanium')).toBeUndefined();
    expect(findFinish('painted')?.emissivity).toBeCloseTo(0.9, 9);
    expect(findFinish('chrome')).toBeUndefined();
  });

  it('lists copies, so a caller cannot edit the library in place', () => {
    const first = listMaterials();
    first.length = 0;
    expect(listMaterials().length).toBeGreaterThan(0);
    expect(listFinishes().some((finish) => finish.id === DEFAULT_FINISH_ID)).toBe(true);
  });
});

describe('resolvePart', () => {
  it('uses the part’s own properties when there is no override', () => {
    const resolved = resolvePart(partWith());
    expect(resolved.material.id).toBe(DEFAULT_MATERIAL_ID);
    expect(resolved.finish.id).toBe(DEFAULT_FINISH_ID);
    expect(resolved.bodyType).toBe('sheet');
    expect(resolved.thickness).toBeCloseTo(0.002, 9);
  });

  it('applies each override field independently', () => {
    const resolved = resolvePart(partWith(), {
      bodyType: 'lump',
      materialId: 'copper',
      thickness: 0.01,
    });
    expect(resolved.bodyType).toBe('lump');
    expect(resolved.material.k).toBeCloseTo(400, 9);
    expect(resolved.finish.id).toBe(DEFAULT_FINISH_ID);
    expect(resolved.thickness).toBeCloseTo(0.01, 9);
  });

  it('clamps a negative thickness to zero rather than inverting the conductance', () => {
    expect(resolvePart(partWith({ thickness: -1 })).thickness).toBe(0);
  });

  it('throws when an override names something that does not exist', () => {
    expect(() => resolvePart(partWith(), { materialId: 'unobtanium' })).toThrow(
      UnknownMaterialError,
    );
    expect(() => resolvePart(partWith({ finishId: 'chrome' }))).toThrow(UnknownFinishError);
  });
});
