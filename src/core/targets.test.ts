import { describe, expect, it } from 'vitest';
import type { Target } from './types';
import { applySelection, dedupeTargets, sameTargets, targetKey, targetsEqual } from './targets';

const part: Target = { type: 'part', partId: 'housing-0' };
const faceA: Target = { type: 'face', partId: 'housing-0', faceId: 3 };
const faceB: Target = { type: 'face', partId: 'housing-0', faceId: 7 };

describe('targetKey', () => {
  it('separates the granularities so a face and its part never collide', () => {
    expect(targetKey(part)).not.toBe(targetKey(faceA));
    expect(targetsEqual(faceA, { type: 'face', partId: 'housing-0', faceId: 3 })).toBe(true);
    expect(targetsEqual(faceA, faceB)).toBe(false);
  });
});

describe('applySelection', () => {
  it('replaces on a plain click and appends on an additive one', () => {
    expect(applySelection([part], faceA, false)).toEqual([faceA]);
    expect(applySelection([part], faceA, true)).toEqual([part, faceA]);
  });

  it('toggles an already-selected target back out', () => {
    expect(applySelection([part, faceA, faceB], faceA, true)).toEqual([part, faceB]);
    // By key, not by reference: a freshly picked face is the same target.
    expect(applySelection([faceA], { type: 'face', partId: 'housing-0', faceId: 3 }, true)).toEqual(
      [],
    );
  });

  it('clears on a plain click into empty space and keeps the selection on an additive one', () => {
    expect(applySelection([part, faceA], null, false)).toEqual([]);
    expect(applySelection([part, faceA], null, true)).toEqual([part, faceA]);
  });
});

describe('dedupeTargets', () => {
  it('keeps the first occurrence and the order the user picked them in', () => {
    const repeat: Target = { type: 'face', partId: 'housing-0', faceId: 3 };
    expect(dedupeTargets([faceB, faceA, repeat, part, faceB])).toEqual([faceB, faceA, part]);
  });

  it('leaves an already-unique set alone', () => {
    expect(dedupeTargets([part, faceA])).toEqual([part, faceA]);
    expect(dedupeTargets([])).toEqual([]);
  });
});

describe('sameTargets', () => {
  it('compares by key, in order', () => {
    expect(
      sameTargets([part, faceA], [part, { type: 'face', partId: 'housing-0', faceId: 3 }]),
    ).toBe(true);
    expect(sameTargets([part, faceA], [faceA, part])).toBe(false);
    expect(sameTargets([part], [part, faceA])).toBe(false);
    expect(sameTargets([], [])).toBe(true);
  });
});
