/**
 * Identity and set arithmetic for `Target`s — what a click selects and what a
 * boundary condition names.
 *
 * Pure index and string maths over the type contract: no renderer, no three.js.
 * The viewer's picker and the state reducers both need the same notion of "the
 * same target", so it lives here rather than behind either of them.
 */

import type { Target } from './types';

/** Stable identity for a target, for set membership and React keys. */
export function targetKey(target: Target): string {
  switch (target.type) {
    case 'part':
      return `part:${target.partId}`;
    case 'face':
      return `face:${target.partId}:${target.faceId}`;
    case 'edge':
      return `edge:${target.partId}:${target.edgeId}`;
    case 'node':
      return `node:${target.partId}:${target.nodeId}`;
    default:
      return 'unknown';
  }
}

export function targetsEqual(a: Target, b: Target): boolean {
  return targetKey(a) === targetKey(b);
}

/**
 * Click semantics: plain click replaces the selection, shift-click toggles the
 * target in and out of it.
 */
export function applySelection(
  selection: readonly Target[],
  target: Target | null,
  additive: boolean,
): Target[] {
  if (!target) return additive ? [...selection] : [];
  if (!additive) return [target];
  const key = targetKey(target);
  const existing = selection.findIndex((candidate) => targetKey(candidate) === key);
  if (existing >= 0) return selection.filter((_, index) => index !== existing);
  return [...selection, target];
}

/** First occurrence wins, so the order the user picked them in survives. */
export function dedupeTargets(targets: readonly Target[]): Target[] {
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const target of targets) {
    const key = targetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

/** Order-sensitive: two sets holding the same targets in a different order differ. */
export function sameTargets(a: readonly Target[], b: readonly Target[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((target, index) => targetKey(target) === targetKey(b[index]));
}
