import { describe, expect, it } from 'vitest';
import { PERFECT_CONTACT, type Contact } from '@/core/types';
import { groupContactsByPartPair } from './contactGroups';

function contact(id: string, partA: string, partB: string, overrides: Partial<Contact> = {}) {
  return {
    id,
    partA,
    partB,
    nodePairs: Uint32Array.of(0, 1),
    pairArea: Float32Array.of(1e-4),
    conductance: PERFECT_CONTACT,
    autoDetected: true,
    enabled: true,
    ...overrides,
  } satisfies Contact;
}

describe('groupContactsByPartPair', () => {
  it('gathers the patches of one joint and sums what they carry', () => {
    const groups = groupContactsByPartPair([
      contact('a', 'bezel-0', 'housing-1', {
        nodePairs: Uint32Array.of(0, 9),
        pairArea: Float32Array.of(2e-4),
      }),
      contact('b', 'dno-2', 'ohisje-3'),
      contact('c', 'bezel-0', 'housing-1', {
        nodePairs: Uint32Array.of(4, 5, 6, 7),
        pairArea: Float32Array.of(1e-4, 3e-4),
      }),
    ]);

    expect(groups.map((group) => group.key)).toEqual(['bezel-0 housing-1', 'dno-2 ohisje-3']);
    expect(groups[0].ids).toEqual(['a', 'c']);
    expect(groups[0].patches.map((patch) => patch.index)).toEqual([1, 2]);
    expect(groups[0].pairCount).toBe(3);
    expect(groups[0].area).toBeCloseTo(6e-4, 8);
    expect(groups[0].enabledCount).toBe(2);
  });

  it('puts a hand-made contact in the same group whichever way round it was built', () => {
    const groups = groupContactsByPartPair([
      contact('detected', 'bezel-0', 'housing-1'),
      contact('manual', 'housing-1', 'bezel-0', { autoDetected: false }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].partA).toBe('bezel-0');
    expect(groups[0].partB).toBe('housing-1');
    expect(groups[0].autoDetected).toBe(false);
  });

  it('reports a conductance only when the patches agree on one', () => {
    const agreeing = groupContactsByPartPair([
      contact('a', 'x-0', 'y-1', { conductance: 500 }),
      contact('b', 'x-0', 'y-1', { conductance: 500 }),
    ]);
    expect(agreeing[0].conductance).toBe(500);
    expect(agreeing[0].perfect).toBe(false);

    const disagreeing = groupContactsByPartPair([
      contact('a', 'x-0', 'y-1', { conductance: 500 }),
      contact('b', 'x-0', 'y-1', { conductance: PERFECT_CONTACT }),
    ]);
    expect(disagreeing[0].conductance).toBeNull();
    expect(disagreeing[0].perfect).toBe(false);
  });

  it('flags the patches whose whole area hangs off a single node pair', () => {
    const groups = groupContactsByPartPair([
      contact('corner', 'bezel-0', 'housing-1', {
        nodePairs: Uint32Array.of(0, 9),
        pairArea: Float32Array.of(5.6e-4),
      }),
      contact('seam', 'bezel-0', 'housing-1', {
        nodePairs: Uint32Array.of(2, 3, 4, 5, 6, 7),
        pairArea: Float32Array.of(1e-4, 1e-4, 1e-4),
      }),
    ]);

    expect(groups[0].patches.map((patch) => patch.singlePair)).toEqual([true, false]);
    expect(groups[0].singlePairPatches).toBe(1);
    expect(groups[0].singlePairArea).toBeCloseTo(5.6e-4, 8);
  });

  it('counts how many patches are switched on, so a part-enabled joint is visible', () => {
    const groups = groupContactsByPartPair([
      contact('a', 'x-0', 'y-1'),
      contact('b', 'x-0', 'y-1', { enabled: false }),
    ]);
    expect(groups[0].enabledCount).toBe(1);
    expect(groups[0].patches).toHaveLength(2);
  });
});
