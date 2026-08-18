/**
 * Boundary conditions, and the selection mode they are created from.
 *
 * A condition applies to a set of targets, so `collect` arms the viewer to stage
 * clicks into a draft group and one press of `+ fixed temp` turns the whole draft
 * into one row. With nothing staged the buttons fall back to the global selection,
 * which keeps the old flow — pick a part in the tree, press the button — working,
 * now as a single grouped row rather than one row per target.
 */

import type { BoundaryCondition, Target } from '@/core/types';
import { celsiusToKelvin } from '@/core/units';
import { targetKey, targetsEqual } from '@/core/targets';
import { describeTarget, SELECTION_MODES, type SelectionMode } from '@/viewer';
import { Panel } from '../components/Panel';
import { ButtonGroup, EmptyState, Hint } from '../components/fields';
import {
  createConvectionCondition,
  createFixedTempCondition,
  createHeatLoadCondition,
} from '../state/entityFactories';
import { useDispatch, useProject } from '../state/projectStore';
import { BoundaryConditionRow } from './BoundaryConditionRow';

const MODE_LABELS: Record<SelectionMode, string> = {
  part: 'part',
  face: 'face',
  edge: 'edge',
  point: 'point',
};

/** Hot enough to be obviously deliberate, and the value the reference scenario uses. */
const DEFAULT_FIXED_TEMP_C = 200;
const DEFAULT_HEAT_LOAD_W = 5;

export function BoundaryConditionsPanel() {
  const { model, scenario, viewer } = useProject();
  const dispatch = useDispatch();
  const draft = viewer.bcDraft;
  const selection = viewer.selection;
  const source = draft.length > 0 ? draft : selection;

  const setDraft = (targets: Target[]) => dispatch({ type: 'view/setBcDraft', targets });

  const addOneCondition = (make: (targets: readonly Target[]) => BoundaryCondition) => {
    if (source.length === 0) return;
    dispatch({ type: 'bc/add', condition: make(source) });
    // Collect stays armed, so the next group can be built straight away.
    setDraft([]);
  };

  return (
    <Panel title="Boundary conditions" badge={scenario.boundaryConditions.length || undefined}>
      <div className="row spread">
        <span className="field-label">select by</span>
        <ButtonGroup
          value={viewer.selectionMode}
          options={SELECTION_MODES.map((mode, index) => ({
            value: mode,
            label: `${MODE_LABELS[mode]} ${index + 1}`,
            title: `Hotkey ${index + 1}`,
          }))}
          onChange={(mode) => dispatch({ type: 'view/setSelectionMode', mode })}
        />
      </div>

      <div className="row spread">
        <button
          type="button"
          className={viewer.bcCollecting ? 'on' : undefined}
          title="Route viewer clicks into a group instead of moving the selection"
          onClick={() =>
            dispatch({ type: 'view/setBcCollecting', collecting: !viewer.bcCollecting })
          }
        >
          collect{draft.length > 0 ? ` (${draft.length})` : ''}
        </button>
        {draft.length > 0 ? (
          <button
            type="button"
            className="mini"
            title="drop every staged target"
            onClick={() => setDraft([])}
          >
            clear
          </button>
        ) : null}
      </div>

      {draft.length > 0 ? (
        <ul className="staged-list">
          {draft.map((target) => (
            <li key={targetKey(target)} className="staged-target">
              <span>{model ? describeTarget(model, target) : target.partId}</span>
              <button
                type="button"
                className="mini"
                title="drop from the group"
                onClick={() => setDraft(draft.filter((staged) => !targetsEqual(staged, target)))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="row">
        <button
          type="button"
          disabled={source.length === 0}
          onClick={() =>
            addOneCondition((targets) =>
              createFixedTempCondition(targets, celsiusToKelvin(DEFAULT_FIXED_TEMP_C)),
            )
          }
        >
          + fixed temp
        </button>
        <button
          type="button"
          disabled={source.length === 0}
          onClick={() =>
            addOneCondition((targets) => createHeatLoadCondition(targets, DEFAULT_HEAT_LOAD_W))
          }
        >
          + heat load
        </button>
        <button
          type="button"
          disabled={source.length === 0}
          onClick={() => addOneCondition((targets) => createConvectionCondition(targets, 'auto'))}
        >
          + convection
        </button>
      </div>
      <Hint>{sourceHint(draft.length, selection.length, viewer.bcCollecting)}</Hint>

      {scenario.boundaryConditions.length === 0 ? (
        <EmptyState>No boundary conditions. A model with none solves to ambient.</EmptyState>
      ) : (
        <ul className="entity-list expandable">
          {scenario.boundaryConditions.map((condition) => (
            <BoundaryConditionRow
              key={condition.id}
              condition={condition}
              model={model}
              scenario={scenario}
              draft={draft}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** What the next `+` press would build, and how to change it. */
function sourceHint(staged: number, selected: number, collecting: boolean): string {
  if (staged > 0) {
    return `${staged} staged — one condition over all of them. Clicking a staged target again drops it.`;
  }
  if (collecting) {
    return 'Collecting: viewer clicks stage a target into the group instead of selecting it, and clicking a staged one again drops it.';
  }
  if (selected === 0) return 'Nothing selected — click the model, or a part in the tree.';
  return `${selected} target${selected === 1 ? '' : 's'} selected — one condition over all of them.`;
}
