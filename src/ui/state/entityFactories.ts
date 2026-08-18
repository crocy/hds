/**
 * Constructors for the scenario entities the user creates by hand.
 *
 * Ids are generated here rather than in the reducer so the reducer stays pure and
 * a test can hand it an entity with a known id.
 */

import type { BoundaryCondition, Material, SurfaceFinish, Target } from '@/core/types';
import { dedupeTargets } from '@/core/targets';

let sequence = 0;

/** Unique within a session and unlikely to collide with ids loaded from a project. */
export function nextEntityId(prefix: string): string {
  sequence += 1;
  const salt = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${sequence.toString(36)}${salt}`;
}

export function createFixedTempCondition(
  targets: readonly Target[],
  kelvin: number,
): BoundaryCondition {
  return {
    id: nextEntityId('bc-fixed'),
    kind: 'fixedTemp',
    targets: dedupeTargets(targets),
    value: kelvin,
    enabled: true,
  };
}

export function createHeatLoadCondition(
  targets: readonly Target[],
  watts: number,
): BoundaryCondition {
  return {
    id: nextEntityId('bc-load'),
    kind: 'heatLoad',
    targets: dedupeTargets(targets),
    watts,
    enabled: true,
  };
}

export function createConvectionCondition(
  targets: readonly Target[],
  h: number | 'auto' = 'auto',
): BoundaryCondition {
  return {
    id: nextEntityId('bc-conv'),
    kind: 'convection',
    targets: dedupeTargets(targets),
    h,
    enabled: true,
  };
}

export function createCustomMaterial(name: string, k: number): Material {
  return { id: nextEntityId('custom-material'), name, k, category: 'custom' };
}

export function createCustomFinish(name: string, emissivity: number): SurfaceFinish {
  return { id: nextEntityId('custom-finish'), name, emissivity };
}
