/**
 * What one boundary condition's group reads as: how it is composed, and what each
 * member of it actually carries.
 *
 * A group may overlap itself — a part plus one of that part's own faces is legal, and
 * the solver injects each node once because it works on the union. Listing the members
 * raw would count the shared nodes twice and make a 5 W group look like more, so every
 * node is attributed here to the *first* member that claims it and the later member
 * reads as covered. Node resolution goes through the solver's own `resolveTargetNodes`,
 * and a member on an insulating part is dropped exactly as `buildDofMap` drops it — that
 * is the only body type the solve gives no DOF at all — so the panel and the solve cannot
 * disagree about what a target means or about what it ends up carrying.
 *
 * Display only: nothing here is persisted or handed to the physics, and the module
 * imports neither React nor three.js — the label for a single target is injected
 * because the viewer's `describeTarget` sits behind the three.js barrel.
 */

import type { BoundaryCondition, Scenario, Target, ThermalModel } from '@/core/types';
import { targetKey } from '@/core/targets';
import { resolveTargetNodes } from '@/physics/assemble';
import { resolvePart } from '@/physics/materials';
import { partNameOf } from './selectors';

export interface ConditionMember {
  target: Target;
  /** Stable identity, for React keys. */
  key: string;
  label: string;
  /** Nodes this member is the first to claim. */
  nodeCount: number;
  /** m² over those nodes. */
  area: number;
  /** Watts it carries, for a `heatLoad`; null for the kinds that have no total to split. */
  watts: number | null;
  /** Names nodes, but an earlier member claimed every one of them. */
  covered: boolean;
  /** Names an insulating part, which the solve leaves out entirely. */
  insulating: boolean;
}

export interface ConditionSummary {
  /** The head label: the group by composition. */
  label: string;
  members: ConditionMember[];
  /** Nodes of the whole group, each counted once. */
  nodeCount: number;
  /** m² over those nodes. */
  area: number;
}

export function summariseConditionTargets(
  model: ThermalModel | null,
  scenario: Scenario,
  condition: BoundaryCondition,
  describe: (target: Target) => string,
): ConditionSummary {
  const insulating = insulatingPartIds(model, scenario);
  const claimed = new Uint8Array(model?.nodeCount ?? 0);
  const members: ConditionMember[] = [];
  let nodeCount = 0;
  let area = 0;

  for (const target of condition.targets) {
    const insulated = insulating.has(target.partId);
    let memberNodes = 0;
    let memberArea = 0;
    let named = 0;
    if (model && !insulated) {
      const nodes = resolveTargetNodes(model, target);
      named = nodes.length;
      for (const node of nodes) {
        if (claimed[node]) continue;
        claimed[node] = 1;
        memberNodes++;
        memberArea += model.nodeArea[node];
      }
    }
    nodeCount += memberNodes;
    area += memberArea;
    members.push({
      target,
      key: targetKey(target),
      label: describe(target),
      nodeCount: memberNodes,
      area: memberArea,
      watts: null,
      covered: named > 0 && memberNodes === 0,
      insulating: insulated,
    });
  }

  if (condition.kind === 'heatLoad') {
    for (const member of members) {
      member.watts = condition.watts * shareOf(member, area, nodeCount);
    }
  }

  return { label: composeLabel(model, condition.targets, describe), members, nodeCount, area };
}

/**
 * The parts `buildDofMap` gives no DOF, and so the only ones whose nodes the solve
 * silently ignores however a condition names them.
 */
function insulatingPartIds(model: ThermalModel | null, scenario: Scenario): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const part of model?.parts ?? []) {
    const resolved = resolvePart(part, scenario.partOverrides[part.id]);
    if (resolved.bodyType === 'insulator') ids.add(part.id);
  }
  return ids;
}

/**
 * The fraction of the group's total a member carries, area-weighted exactly as the
 * assembler weights it, down to falling back on an equal share per node where the
 * geometry has no area to weight by.
 */
function shareOf(member: ConditionMember, totalArea: number, totalNodes: number): number {
  if (totalArea > 0) return member.area / totalArea;
  return totalNodes > 0 ? member.nodeCount / totalNodes : 0;
}

const GRANULARITIES: ReadonlyArray<{ type: Target['type']; noun: string }> = [
  { type: 'part', noun: 'part' },
  { type: 'face', noun: 'face' },
  { type: 'edge', noun: 'edge' },
  { type: 'node', noun: 'node' },
];

function composeLabel(
  model: ThermalModel | null,
  targets: readonly Target[],
  describe: (target: Target) => string,
): string {
  if (targets.length === 1) return describe(targets[0]);

  const counts = GRANULARITIES.map((granularity) => ({
    ...granularity,
    count: targets.filter((target) => target.type === granularity.type).length,
  })).filter((granularity) => granularity.count > 0);

  if (counts.length === 1) {
    const { type, noun, count } = counts[0];
    if (type === 'part') return plural(count, 'part');
    const partIds = new Set(targets.map((target) => target.partId));
    return partIds.size === 1
      ? `${partNameOf(model, targets[0].partId)} · ${plural(count, noun)}`
      : `${plural(count, noun)} on ${plural(partIds.size, 'part')}`;
  }

  return counts.map(({ count, noun }) => plural(count, noun)).join(' + ');
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
