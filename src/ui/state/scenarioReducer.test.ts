import { describe, expect, it } from 'vitest';
import { createDefaultScenario } from '@/core/defaults';
import {
  PERFECT_CONTACT,
  type BoundaryCondition,
  type Cavity,
  type Contact,
  type Target,
} from '@/core/types';
import { celsiusToKelvin } from '@/core/units';
import { patchBoundaryCondition, scenarioReducer } from './scenarioReducer';

function scenarioWith(overrides: Partial<ReturnType<typeof createDefaultScenario>> = {}) {
  return { ...createDefaultScenario(), ...overrides };
}

const fixedTemp: BoundaryCondition = {
  id: 'bc-1',
  kind: 'fixedTemp',
  targets: [{ type: 'part', partId: 'housing-0' }],
  value: celsiusToKelvin(200),
  enabled: true,
};

const contact: Contact = {
  id: 'contact-1',
  partA: 'a-0',
  partB: 'b-1',
  nodePairs: Uint32Array.of(0, 1),
  pairArea: Float32Array.of(1e-4),
  conductance: 500,
  autoDetected: true,
  enabled: true,
};

const cavity: Cavity = {
  id: 1,
  name: 'cavity 1',
  condition: 'stillAir',
  h: 5,
  emissivity: 0.5,
  fillK: 0.026,
  triCount: 40,
};

describe('scenarioReducer', () => {
  it('leaves untouched arrays identical so the viewer can skip rebuilding them', () => {
    const before = scenarioWith({ boundaryConditions: [fixedTemp], contacts: [contact] });
    const after = scenarioReducer(before, {
      type: 'parts/patchOverride',
      partIds: ['housing-0'],
      patch: { thickness: 0.002 },
    });

    expect(after).not.toBe(before);
    expect(after.partOverrides['housing-0'].thickness).toBe(0.002);
    expect(after.boundaryConditions).toBe(before.boundaryConditions);
    expect(after.contacts).toBe(before.contacts);
    expect(after.cavities).toBe(before.cavities);
  });

  it('returns the same state when an action changes nothing', () => {
    const before = scenarioWith();
    expect(scenarioReducer(before, { type: 'scenario/setAmbient', ambient: before.ambient })).toBe(
      before,
    );
    expect(
      scenarioReducer(before, { type: 'bc/patch', id: 'missing', patch: { enabled: false } }),
    ).toBe(before);
    expect(scenarioReducer(before, { type: 'contacts/remove', id: 'missing' })).toBe(before);
    expect(
      scenarioReducer(before, {
        type: 'scenario/setSolver',
        patch: { tolerance: before.solver.tolerance },
      }),
    ).toBe(before);
  });

  it('merges part overrides across a multi-part edit without dropping earlier keys', () => {
    const start = scenarioReducer(scenarioWith(), {
      type: 'parts/patchOverride',
      partIds: ['a-0', 'b-1'],
      patch: { materialId: 'al6061' },
    });
    const after = scenarioReducer(start, {
      type: 'parts/patchOverride',
      partIds: ['a-0'],
      patch: { thickness: 0.003 },
    });

    expect(after.partOverrides['a-0']).toEqual({ materialId: 'al6061', thickness: 0.003 });
    expect(after.partOverrides['b-1']).toEqual({ materialId: 'al6061' });
  });

  it('isolate hides every other part and leaves their other overrides alone', () => {
    const start = scenarioWith({ partOverrides: { 'b-1': { opacity: 0.4 } } });
    const after = scenarioReducer(start, {
      type: 'parts/isolate',
      partIds: ['a-0'],
      allPartIds: ['a-0', 'b-1'],
    });

    expect(after.partOverrides['a-0'].visible).toBe(true);
    expect(after.partOverrides['b-1']).toEqual({ opacity: 0.4, visible: false });
  });

  it('switching a cavity condition resets its coefficients and copies rather than mutates', () => {
    const before = scenarioWith({ cavities: [cavity] });
    const after = scenarioReducer(before, {
      type: 'cavities/setCondition',
      id: 1,
      condition: 'adiabatic',
    });

    expect(after.cavities[0]).toMatchObject({
      condition: 'adiabatic',
      h: 0,
      emissivity: 0,
      fillK: 0,
    });
    expect(before.cavities[0]).toMatchObject({ condition: 'stillAir', h: 5 });
  });

  it('patches a contact conductance and keeps its node pairs', () => {
    const before = scenarioWith({ contacts: [contact] });
    const after = scenarioReducer(before, {
      type: 'contacts/patch',
      id: 'contact-1',
      patch: { conductance: PERFECT_CONTACT },
    });

    expect(after.contacts[0].conductance).toBe(PERFECT_CONTACT);
    expect(after.contacts[0].nodePairs).toBe(contact.nodePairs);
  });

  it('patches every patch of a joint at once, leaving the rest identical', () => {
    const second = { ...contact, id: 'contact-2', conductance: 900 };
    const other = { ...contact, id: 'contact-3', partB: 'c-2' };
    const before = scenarioWith({ contacts: [contact, second, other] });
    const after = scenarioReducer(before, {
      type: 'contacts/patchMany',
      ids: ['contact-1', 'contact-2'],
      patch: { conductance: 250 },
    });

    expect(after.contacts.map((c) => c.conductance)).toEqual([250, 250, contact.conductance]);
    expect(after.contacts[2]).toBe(other);
    expect(
      scenarioReducer(after, {
        type: 'contacts/patchMany',
        ids: ['contact-1', 'contact-2'],
        patch: { conductance: 250 },
      }),
    ).toBe(after);
  });
});

describe('bc/add', () => {
  it('deduplicates the member set of the condition it is handed', () => {
    const face: Target = { type: 'face', partId: 'housing-0', faceId: 3 };
    const after = scenarioReducer(scenarioWith(), {
      type: 'bc/add',
      condition: { ...fixedTemp, targets: [face, { ...face }] },
    });

    expect(after.boundaryConditions[0].targets).toEqual([face]);
  });

  it('ignores a condition that names nothing', () => {
    const before = scenarioWith();
    expect(
      scenarioReducer(before, { type: 'bc/add', condition: { ...fixedTemp, targets: [] } }),
    ).toBe(before);
  });
});

describe('bc/setTargets', () => {
  const faceA: Target = { type: 'face', partId: 'housing-0', faceId: 3 };
  const faceB: Target = { type: 'face', partId: 'housing-0', faceId: 7 };

  it('deduplicates the incoming set, keeping the order it was picked in', () => {
    const before = scenarioWith({ boundaryConditions: [fixedTemp] });
    const after = scenarioReducer(before, {
      type: 'bc/setTargets',
      id: 'bc-1',
      targets: [faceB, faceA, { ...faceB }],
    });

    expect(after.boundaryConditions[0].targets).toEqual([faceB, faceA]);
  });

  it('refuses an empty set rather than writing a condition that names nothing', () => {
    const before = scenarioWith({ boundaryConditions: [fixedTemp] });
    expect(scenarioReducer(before, { type: 'bc/setTargets', id: 'bc-1', targets: [] })).toBe(
      before,
    );
  });

  it('returns the same state when the set is unchanged, and for an unknown id', () => {
    const before = scenarioWith({ boundaryConditions: [fixedTemp] });
    expect(
      scenarioReducer(before, {
        type: 'bc/setTargets',
        id: 'bc-1',
        targets: [{ type: 'part', partId: 'housing-0' }],
      }),
    ).toBe(before);
    expect(
      scenarioReducer(before, { type: 'bc/setTargets', id: 'missing', targets: [faceA] }),
    ).toBe(before);
  });
});

describe('patchBoundaryCondition', () => {
  it('applies only the field belonging to the condition kind', () => {
    const patched = patchBoundaryCondition(fixedTemp, { value: 300, watts: 12 });
    expect(patched).toMatchObject({ kind: 'fixedTemp', value: 300 });
    expect(patched).not.toHaveProperty('watts');
  });

  it('returns the same object when nothing moves', () => {
    expect(patchBoundaryCondition(fixedTemp, { value: fixedTemp.value })).toBe(fixedTemp);
  });

  it('round-trips convection between auto and a fixed film coefficient', () => {
    const auto: BoundaryCondition = {
      id: 'bc-2',
      kind: 'convection',
      targets: [{ type: 'face', partId: 'a-0', faceId: 3 }],
      h: 'auto',
      enabled: true,
    };
    const fixed = patchBoundaryCondition(auto, { h: 12 });
    expect(fixed).toMatchObject({ h: 12 });
    expect(patchBoundaryCondition(fixed, { h: 'auto' })).toMatchObject({ h: 'auto' });
  });
});
