import { describe, expect, it } from 'vitest';
import { twoStripModel } from '@/core/testModels';
import type { SolveResult } from '@/core/types';
import { createInitialState, projectReducer, type ProjectState } from './projectReducer';

const model = twoStripModel(0.1, 0.02, 4);

function solved(state: ProjectState): ProjectState {
  const result = {
    temperature: new Float32Array(model.nodeCount).fill(300),
    minTemp: 300,
    maxTemp: 300,
    balance: {
      injectedAtFixed: 0,
      injectedAtLoads: 0,
      lostByConvection: 0,
      lostByRadiation: 0,
      residual: 0,
      perPart: [],
      perContact: [],
      perCavity: [],
    },
    outerIterations: 3,
    converged: true,
    warnings: [],
    elapsedMs: 12,
  } satisfies SolveResult;
  return projectReducer(state, { type: 'solve/succeeded', result });
}

describe('projectReducer', () => {
  it('marks a solve stale when the scenario changes the answer, but not when only the view does', () => {
    const base = solved(createInitialState());
    expect(base.solve.stale).toBe(false);

    const recoloured = projectReducer(base, {
      type: 'scenario/setColorScale',
      patch: { mode: 'manual' },
    });
    expect(recoloured.solve.stale).toBe(false);

    const hidden = projectReducer(recoloured, {
      type: 'parts/patchOverride',
      partIds: ['left-0'],
      patch: { visible: false },
    });
    expect(hidden.solve.stale).toBe(false);

    const thickened = projectReducer(hidden, {
      type: 'parts/patchOverride',
      partIds: ['left-0'],
      patch: { thickness: 0.004 },
    });
    expect(thickened.solve.stale).toBe(true);
    expect(thickened.solve.result).toBe(base.solve.result);
  });

  it('keeps state identical when a section patch changes nothing, so the gizmo cannot loop', () => {
    const start = createInitialState();
    const moved = projectReducer(start, { type: 'view/patchSection', patch: { offset: 0.01 } });
    expect(moved).not.toBe(start);
    expect(projectReducer(moved, { type: 'view/patchSection', patch: { offset: 0.01 } })).toBe(
      moved,
    );
  });

  it('re-centres the section and clears the selection when a new model is loaded', () => {
    const start = projectReducer(
      projectReducer(
        projectReducer(createInitialState(), {
          type: 'view/patchSection',
          patch: { offset: 0.05 },
        }),
        { type: 'view/setSelection', selection: [{ type: 'part', partId: 'left-0' }] },
      ),
      { type: 'view/setBcDraft', targets: [{ type: 'part', partId: 'left-0' }] },
    );

    const loaded = projectReducer(start, {
      type: 'model/loaded',
      model,
      source: null,
      cavities: [],
      contacts: [],
    });

    expect(loaded.viewer.section.offset).toBeNull();
    expect(loaded.viewer.selection).toEqual([]);
    // The staged group names the old geometry's parts, like the selection does.
    expect(loaded.viewer.bcDraft).toEqual([]);
    expect(loaded.modelRevision).toBe(start.modelRevision + 1);
  });

  it('carries ambient and solver settings across an import but not the part overrides', () => {
    const configured = projectReducer(
      projectReducer(createInitialState(), { type: 'scenario/setAmbient', ambient: 313.15 }),
      { type: 'parts/patchOverride', partIds: ['old-0'], patch: { thickness: 0.01 } },
    );

    const loaded = projectReducer(configured, {
      type: 'model/loaded',
      model,
      source: null,
      cavities: [],
      contacts: [],
    });

    expect(loaded.scenario.ambient).toBe(313.15);
    expect(loaded.scenario.partOverrides).toEqual({});
  });

  it('stages a boundary-condition draft without disturbing the selection', () => {
    const selected = projectReducer(createInitialState(), {
      type: 'view/setSelection',
      selection: [{ type: 'part', partId: 'left-0' }],
    });
    const staged = projectReducer(selected, {
      type: 'view/setBcDraft',
      targets: [{ type: 'face', partId: 'left-0', faceId: 2 }],
    });

    expect(staged.viewer.bcDraft).toHaveLength(1);
    expect(staged.viewer.selection).toBe(selected.viewer.selection);
    expect(
      projectReducer(staged, {
        type: 'view/setBcDraft',
        targets: [{ type: 'face', partId: 'left-0', faceId: 2 }],
      }),
    ).toBe(staged);
  });

  it('arms and disarms collecting, and ignores a repeat of either', () => {
    const start = createInitialState();
    expect(start.viewer.bcCollecting).toBe(false);
    expect(projectReducer(start, { type: 'view/setBcCollecting', collecting: false })).toBe(start);

    const armed = projectReducer(start, { type: 'view/setBcCollecting', collecting: true });
    expect(armed.viewer.bcCollecting).toBe(true);
    expect(projectReducer(armed, { type: 'view/setBcCollecting', collecting: true })).toBe(armed);
  });

  it('drops a duplicate selection rather than re-rendering the viewer for it', () => {
    const start = projectReducer(createInitialState(), {
      type: 'view/setSelection',
      selection: [{ type: 'face', partId: 'left-0', faceId: 2 }],
    });
    expect(
      projectReducer(start, {
        type: 'view/setSelection',
        selection: [{ type: 'face', partId: 'left-0', faceId: 2 }],
      }),
    ).toBe(start);
  });
});
