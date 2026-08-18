import { describe, expect, it } from 'vitest';
import { createDefaultScenario } from '@/core/defaults';
import { twoStripModel } from '@/core/testModels';
import type { BoundaryCondition, Cavity, Contact, Scenario } from '@/core/types';
import { celsiusToKelvin } from '@/core/units';
import { DEFAULT_VIEWER_STATE } from '@/ui/state/viewerState';
import {
  createProjectFile,
  openProject,
  parseProjectFile,
  resolveScenarioAgainstModel,
  serialiseProject,
  type ProjectSnapshot,
} from './project';

const model = twoStripModel(0.1, 0.02, 6);
const [left, right] = model.parts;

const contact: Contact = {
  id: 'contact-left-right-1',
  partA: left.id,
  partB: right.id,
  nodePairs: Uint32Array.of(0, model.nodeCount - 1),
  pairArea: Float32Array.of(2.5e-5),
  conductance: 800,
  autoDetected: true,
  enabled: true,
};

const cavity: Cavity = {
  id: 1,
  name: 'cavity 1',
  condition: 'insulated',
  h: 0.5,
  emissivity: 0.2,
  fillK: 0.04,
  triCount: 0,
};

const fixedTemp: BoundaryCondition = {
  id: 'bc-1',
  kind: 'fixedTemp',
  targets: [{ type: 'part', partId: left.id }],
  value: celsiusToKelvin(200),
  enabled: true,
};

function scenario(): Scenario {
  return {
    ...createDefaultScenario(),
    boundaryConditions: [fixedTemp],
    contacts: [contact],
    partOverrides: { [left.id]: { thickness: 0.002, materialId: 'al6061' } },
  };
}

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    source: { name: 'strips.step', hash: 'sha256:abc', units: 'mm' },
    scenario: scenario(),
    viewer: { ...DEFAULT_VIEWER_STATE, wireframe: true },
    customMaterials: [{ id: 'custom-1', name: 'Mystery alloy', k: 42, category: 'custom' }],
    customFinishes: [{ id: 'custom-finish-1', name: 'Mystery coat', emissivity: 0.66 }],
    model,
    embedMesh: true,
    ...overrides,
  };
}

/**
 * A real project envelope — mesh, contacts and all — carrying hand-written version 1
 * boundary conditions and a viewer state from before the staged draft existed.
 */
function version1Text(conditions: unknown[]): string {
  const file = createProjectFile(snapshot({ scenario: { ...scenario(), boundaryConditions: [] } }));
  const { bcDraft: _bcDraft, bcCollecting: _bcCollecting, ...viewer } = file.viewer;
  return JSON.stringify({
    ...file,
    version: 1,
    viewer,
    scenario: { ...file.scenario, boundaryConditions: conditions },
  });
}

describe('project files', () => {
  it('round-trips a scenario, its typed arrays and the embedded mesh', () => {
    const opened = openProject(parseProjectFile(serialiseProject(snapshot())), null);

    expect(opened.issues).toEqual([]);
    expect(opened.scenario.partOverrides[left.id]).toEqual({
      thickness: 0.002,
      materialId: 'al6061',
    });
    expect(opened.scenario.boundaryConditions[0]).toEqual(fixedTemp);
    expect(opened.scenario.contacts[0].nodePairs).toBeInstanceOf(Uint32Array);
    expect([...opened.scenario.contacts[0].nodePairs]).toEqual([...contact.nodePairs]);
    expect([...opened.scenario.contacts[0].pairArea]).toEqual([...contact.pairArea]);
    expect(opened.customMaterials[0].k).toBe(42);
    expect(opened.viewer.wireframe).toBe(true);

    const reopened = opened.model;
    expect(reopened).not.toBeNull();
    expect(reopened?.nodeCount).toBe(model.nodeCount);
    expect(reopened?.triCount).toBe(model.triCount);
    expect(reopened?.parts.map((part) => part.id)).toEqual(model.parts.map((part) => part.id));
    expect([...(reopened?.nodes ?? [])]).toEqual([...model.nodes]);
    expect([...(reopened?.tris ?? [])]).toEqual([...model.tris]);
  });

  it('refuses a file that is not an HDS project, by name', () => {
    expect(() => parseProjectFile('{"format":"something-else"}')).toThrow(/Not an HDS project/);
    expect(() => parseProjectFile('not json at all')).toThrow(/Not a JSON file/);
    expect(() => parseProjectFile('{"format":"hds.project","version":99}')).toThrow(/version 99/);
  });

  it('reads the versions it upgrades and refuses the ones it does not know', () => {
    expect(parseProjectFile(version1Text([])).version).toBe(1);
    expect(parseProjectFile(serialiseProject(snapshot())).version).toBe(2);
    expect(() => parseProjectFile('{"format":"hds.project","version":3}')).toThrow(/version 3/);
    expect(() => parseProjectFile('{"format":"hds.project","version":0}')).toThrow(/version 0/);
  });

  it('carries every member of a group through a round trip, in order', () => {
    const group: BoundaryCondition = {
      id: 'bc-group',
      kind: 'heatLoad',
      targets: [
        { type: 'face', partId: left.id, faceId: 0 },
        { type: 'part', partId: right.id },
        { type: 'node', partId: left.id, nodeId: 3 },
      ],
      watts: 12,
      enabled: true,
    };
    const opened = openProject(
      parseProjectFile(
        serialiseProject(snapshot({ scenario: { ...scenario(), boundaryConditions: [group] } })),
      ),
      null,
    );

    expect(opened.issues).toEqual([]);
    expect(opened.scenario.boundaryConditions).toEqual([group]);
  });

  it('never writes the staged draft, and reopens with an empty one', () => {
    const staged = snapshot({
      viewer: {
        ...DEFAULT_VIEWER_STATE,
        bcDraft: [{ type: 'face', partId: left.id, faceId: 0 }],
        bcCollecting: true,
      },
    });

    const file = createProjectFile(staged);
    expect(file.viewer.bcDraft).toEqual([]);
    expect(file.viewer.bcCollecting).toBe(false);

    const opened = openProject(parseProjectFile(JSON.stringify(file)), null);
    expect(opened.viewer.bcDraft).toEqual([]);
    expect(opened.viewer.bcCollecting).toBe(false);
  });

  it('reports that a project without an embedded mesh has nothing to bind to', () => {
    const opened = openProject(
      parseProjectFile(serialiseProject(snapshot({ embedMesh: false }))),
      null,
    );
    expect(opened.model).toBeNull();
    expect(opened.issues.map((issue) => issue.kind)).toContain('geometry');
    // The scenario survives unresolved rather than being emptied.
    expect(opened.scenario.boundaryConditions).toHaveLength(1);
  });

  it('binds a mesh-less project to a model imported separately', () => {
    const opened = openProject(
      parseProjectFile(serialiseProject(snapshot({ embedMesh: false }))),
      model,
    );
    expect(opened.issues.filter((issue) => issue.kind !== 'geometry')).toEqual([]);
    expect(opened.scenario.contacts).toHaveLength(1);
  });
});

describe('version 1 projects', () => {
  it('upgrades each single-target condition into a one-member group', () => {
    const opened = openProject(
      parseProjectFile(
        version1Text([
          {
            id: 'bc-1',
            kind: 'fixedTemp',
            target: { type: 'part', partId: left.id },
            value: celsiusToKelvin(200),
            enabled: true,
          },
          {
            id: 'bc-2',
            kind: 'heatLoad',
            target: { type: 'face', partId: right.id, faceId: 1 },
            watts: 5,
            enabled: false,
          },
        ]),
      ),
      null,
    );

    expect(opened.issues).toEqual([]);
    expect(opened.scenario.boundaryConditions).toEqual([
      {
        id: 'bc-1',
        kind: 'fixedTemp',
        targets: [{ type: 'part', partId: left.id }],
        value: celsiusToKelvin(200),
        enabled: true,
      },
      {
        id: 'bc-2',
        kind: 'heatLoad',
        targets: [{ type: 'face', partId: right.id, faceId: 1 }],
        watts: 5,
        enabled: false,
      },
    ]);
    // The fields did not exist in version 1; the defaults fill them in.
    expect(opened.viewer.bcDraft).toEqual([]);
    expect(opened.viewer.bcCollecting).toBe(false);
  });

  it('reports a condition whose target no longer resolves instead of crashing on it', () => {
    const opened = openProject(
      parseProjectFile(
        version1Text([
          {
            id: 'bc-gone',
            kind: 'fixedTemp',
            target: { type: 'face', partId: left.id, faceId: 9999 },
            value: celsiusToKelvin(80),
            enabled: true,
          },
        ]),
      ),
      null,
    );

    expect(opened.scenario.boundaryConditions).toEqual([]);
    const issue = opened.issues.find((entry) => entry.id === 'bc-gone');
    expect(issue?.kind).toBe('boundaryCondition');
    expect(issue?.detail).toMatch(/no nodes/);
  });

  it('drops a condition with no readable target rather than upgrading it to an empty group', () => {
    const opened = openProject(
      parseProjectFile(
        version1Text([
          { id: 'bc-targetless', kind: 'fixedTemp', value: celsiusToKelvin(50), enabled: true },
          {
            id: 'bc-malformed',
            kind: 'convection',
            target: { type: 'face', partId: left.id },
            h: 'auto',
            enabled: true,
          },
          {
            id: 'bc-ok',
            kind: 'fixedTemp',
            target: { type: 'part', partId: right.id },
            value: celsiusToKelvin(50),
            enabled: true,
          },
        ]),
      ),
      null,
    );

    expect(opened.scenario.boundaryConditions.map((condition) => condition.id)).toEqual(['bc-ok']);
    expect(opened.scenario.boundaryConditions.every((entry) => entry.targets.length > 0)).toBe(
      true,
    );
    expect(opened.issues.filter((issue) => issue.kind === 'boundaryCondition')).toEqual([
      {
        kind: 'boundaryCondition',
        id: 'bc-targetless',
        detail: expect.stringMatching(/fixedTemp .*dropped/),
      },
      {
        kind: 'boundaryCondition',
        id: 'bc-malformed',
        detail: expect.stringMatching(/convection .*dropped/),
      },
    ]);
  });
});

describe('resolveScenarioAgainstModel', () => {
  it('drops what no longer resolves and reports every one', () => {
    const broken: Scenario = {
      ...scenario(),
      partOverrides: { 'gone-9': { thickness: 0.001 } },
      boundaryConditions: [
        fixedTemp,
        { ...fixedTemp, id: 'bc-missing', targets: [{ type: 'part', partId: 'gone-9' }] },
        { ...fixedTemp, id: 'bc-face', targets: [{ type: 'face', partId: left.id, faceId: 9999 }] },
      ],
      contacts: [contact, { ...contact, id: 'contact-missing', partB: 'gone-9' }],
      cavities: [cavity],
    };

    const { scenario: resolved, issues } = resolveScenarioAgainstModel(broken, model);

    expect(resolved.boundaryConditions.map((condition) => condition.id)).toEqual(['bc-1']);
    expect(resolved.contacts.map((entry) => entry.id)).toEqual([contact.id]);
    expect(resolved.partOverrides).toEqual({});
    expect(resolved.cavities).toEqual([]);

    const kinds = issues.map((issue) => issue.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['partOverride', 'boundaryCondition', 'contact', 'cavity']),
    );
    expect(issues.find((issue) => issue.id === 'bc-face')?.detail).toMatch(/no nodes/);
    expect(issues.find((issue) => issue.id === 'contact-missing')?.detail).toMatch(/gone-9/);
  });

  it('keeps a group on its surviving members and reports the ones that went', () => {
    const partial: Scenario = {
      ...scenario(),
      boundaryConditions: [
        {
          ...fixedTemp,
          id: 'bc-group',
          targets: [
            { type: 'part', partId: left.id },
            { type: 'face', partId: left.id, faceId: 9999 },
          ],
        },
      ],
    };

    const { scenario: resolved, issues } = resolveScenarioAgainstModel(partial, model);

    expect(resolved.boundaryConditions).toHaveLength(1);
    expect(resolved.boundaryConditions[0].targets).toEqual([{ type: 'part', partId: left.id }]);
    expect(issues.find((issue) => issue.id === 'bc-group')?.detail).toMatch(/no nodes/);
  });

  it('keeps the scenario object identical when everything resolves', () => {
    const intact = scenario();
    const { scenario: resolved, issues } = resolveScenarioAgainstModel(intact, model);
    expect(resolved).toBe(intact);
    expect(issues).toEqual([]);
  });

  it('rejects a contact whose node indices are past the end of the model', () => {
    const overrun: Scenario = {
      ...scenario(),
      contacts: [{ ...contact, nodePairs: Uint32Array.of(0, model.nodeCount + 5) }],
    };
    const { scenario: resolved, issues } = resolveScenarioAgainstModel(overrun, model);
    expect(resolved.contacts).toEqual([]);
    expect(issues[0].detail).toMatch(/past the end/);
  });
});
