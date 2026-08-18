import { describe, expect, it } from 'vitest';
import { targetKey } from '@/core/targets';
import { mergeMeshes, modelFromMesh, stripMesh } from '@/core/testModels';
import { createDefaultScenario } from '@/core/defaults';
import type { BoundaryCondition, Scenario, Target, ThermalModel } from '@/core/types';
import { summariseConditionTargets } from './conditionTargets';

/** housing (part-0) with two 0.002 m² faces, bracket (part-1) with one of 0.001 m². */
function twoPartModel(): ThermalModel {
  return modelFromMesh(
    mergeMeshes(
      stripMesh(0.1, 0.02, 1, 1, 0, 0),
      stripMesh(0.1, 0.02, 1, 1, 0, 1, [0, 0.03, 0]),
      stripMesh(0.05, 0.02, 1, 1, 1, 0, [0.2, 0, 0]),
    ),
    [{ name: 'housing' }, { name: 'bracket' }],
  );
}

const housing: Target = { type: 'part', partId: 'part-0' };
const bracket: Target = { type: 'part', partId: 'part-1' };
const housingFace = (faceId: number): Target => ({ type: 'face', partId: 'part-0', faceId });
const bracketFace = (faceId: number): Target => ({ type: 'face', partId: 'part-1', faceId });
const housingEdge = (edgeId: number): Target => ({ type: 'edge', partId: 'part-0', edgeId });

const plainScenario = (): Scenario => createDefaultScenario(20);

/** Every part left as imported; only the body-type override matters here. */
function scenarioWithInsulator(partId: string): Scenario {
  const scenario = plainScenario();
  scenario.partOverrides[partId] = { bodyType: 'insulator' };
  return scenario;
}

/** Stands in for the viewer's `describeTarget`, which the panel injects. */
const describeTarget = (target: Target) => `«${targetKey(target)}»`;

function fixedTempOn(targets: Target[]): BoundaryCondition {
  return { id: 'bc-1', kind: 'fixedTemp', targets, value: 400, enabled: true };
}

function heatLoadOn(targets: Target[], watts: number): BoundaryCondition {
  return { id: 'bc-2', kind: 'heatLoad', targets, watts, enabled: true };
}

function labelOf(model: ThermalModel, targets: Target[]): string {
  return summariseConditionTargets(model, plainScenario(), fixedTempOn(targets), describeTarget)
    .label;
}

describe('summariseConditionTargets labels', () => {
  const model = twoPartModel();

  it('describes a lone member exactly as the target itself is described', () => {
    expect(labelOf(model, [housingFace(1)])).toBe(describeTarget(housingFace(1)));
  });

  it('names the part when every member sits on one', () => {
    expect(labelOf(model, [housingFace(0), housingFace(1)])).toBe('housing · 2 faces');
  });

  it('counts the parts when the members span several', () => {
    expect(labelOf(model, [housingFace(0), housingFace(1), bracketFace(0)])).toBe(
      '3 faces on 2 parts',
    );
    expect(labelOf(model, [housing, bracket])).toBe('2 parts');
  });

  it('splits the count by granularity when the members mix', () => {
    expect(labelOf(model, [housingFace(0), housingFace(1), housingEdge(3)])).toBe(
      '2 faces + 1 edge',
    );
  });
});

describe('summariseConditionTargets members', () => {
  const model = twoPartModel();

  it('attributes each node to the first member that claims it', () => {
    const summary = summariseConditionTargets(
      model,
      plainScenario(),
      fixedTempOn([housing, housingFace(1)]),
      describeTarget,
    );

    expect(summary.members.map((member) => member.nodeCount)).toEqual([8, 0]);
    expect(summary.members[1].covered).toBe(true);
    expect(summary.nodeCount).toBe(8);
  });

  it('does not call a member the geometry lost covered', () => {
    const summary = summariseConditionTargets(
      model,
      plainScenario(),
      fixedTempOn([housingFace(0), housingFace(99)]),
      describeTarget,
    );

    expect(summary.members[1].nodeCount).toBe(0);
    expect(summary.members[1].covered).toBe(false);
  });

  it('splits a heat load by area, and the parts sum to the typed total', () => {
    const summary = summariseConditionTargets(
      model,
      plainScenario(),
      heatLoadOn([housingFace(0), bracketFace(0)], 5),
      describeTarget,
    );
    const watts = summary.members.map((member) => member.watts ?? 0);

    expect(watts[0]).toBeCloseTo(10 / 3, 6);
    expect(watts[1]).toBeCloseTo(5 / 3, 6);
    expect(watts[0] + watts[1]).toBeCloseTo(5, 9);
  });

  it('gives a covered member none of the watts, leaving the total with the first', () => {
    const summary = summariseConditionTargets(
      model,
      plainScenario(),
      heatLoadOn([housing, housingFace(1)], 6),
      describeTarget,
    );

    expect(summary.members.map((member) => member.watts)).toEqual([6, 0]);
  });

  it('carries no watts for the kinds that have no total to split', () => {
    const summary = summariseConditionTargets(
      model,
      plainScenario(),
      fixedTempOn([housingFace(0)]),
      describeTarget,
    );

    expect(summary.members[0].watts).toBeNull();
    expect(summary.members[0].area).toBeCloseTo(0.002, 9);
  });
});

describe('summariseConditionTargets against the DOF map', () => {
  const model = twoPartModel();

  it('leaves an insulating member out, exactly as the solve does', () => {
    const summary = summariseConditionTargets(
      model,
      scenarioWithInsulator('part-1'),
      heatLoadOn([housingFace(0), bracketFace(0)], 5),
      describeTarget,
    );

    expect(summary.members[1].insulating).toBe(true);
    expect(summary.members[1].nodeCount).toBe(0);
    // The whole 5 W lands on the member the solve can actually reach.
    expect(summary.members[0].watts).toBeCloseTo(5, 9);
    expect(summary.members[1].watts).toBe(0);
  });

  it('does not mistake an insulating member for one an earlier member covered', () => {
    const summary = summariseConditionTargets(
      model,
      scenarioWithInsulator('part-1'),
      fixedTempOn([housing, bracket]),
      describeTarget,
    );

    expect(summary.members[1].covered).toBe(false);
    expect(summary.members[1].insulating).toBe(true);
    expect(summary.nodeCount).toBe(summary.members[0].nodeCount);
  });
});
