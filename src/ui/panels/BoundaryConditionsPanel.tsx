/**
 * Boundary conditions, and the selection mode they are created from.
 *
 * Each row shows how many nodes its target actually resolves to, computed with the
 * solver's own `resolveTargetNodes` — a condition on a face that no longer exists
 * reads "0 nodes" here rather than quietly doing nothing during the solve.
 */

import type { BoundaryCondition, Target } from '@/core/types';
import { celsiusToKelvin, kelvinToCelsius } from '@/core/units';
import { resolveTargetNodes } from '@/physics/assemble';
import { describeTarget, SELECTION_MODES, type SelectionMode } from '@/viewer';
import { Panel } from '../components/Panel';
import { ButtonGroup, EmptyState, Hint, NumberField } from '../components/fields';
import {
  createConvectionCondition,
  createFixedTempCondition,
  createHeatLoadCondition,
} from '../state/entityFactories';
import { useDispatch, useProject } from '../state/projectStore';

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
  const selection = viewer.selection;

  const addFromSelection = (make: (target: Target) => BoundaryCondition) => {
    for (const target of selection) dispatch({ type: 'bc/add', condition: make(target) });
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

      <div className="row">
        <button
          type="button"
          disabled={selection.length === 0}
          onClick={() =>
            addFromSelection((target) =>
              createFixedTempCondition(target, celsiusToKelvin(DEFAULT_FIXED_TEMP_C)),
            )
          }
        >
          + fixed temp
        </button>
        <button
          type="button"
          disabled={selection.length === 0}
          onClick={() =>
            addFromSelection((target) => createHeatLoadCondition(target, DEFAULT_HEAT_LOAD_W))
          }
        >
          + heat load
        </button>
        <button
          type="button"
          disabled={selection.length === 0}
          onClick={() => addFromSelection((target) => createConvectionCondition(target, 'auto'))}
        >
          + convection
        </button>
      </div>
      <Hint>
        {selection.length === 0
          ? 'Nothing selected — click the model, or a part in the tree.'
          : `${selection.length} target${selection.length === 1 ? '' : 's'} selected.`}
      </Hint>

      {scenario.boundaryConditions.length === 0 ? (
        <EmptyState>No boundary conditions. A model with none solves to ambient.</EmptyState>
      ) : (
        <ul className="entity-list">
          {scenario.boundaryConditions.map((condition) => {
            const nodes = model ? resolveTargetNodes(model, condition.target).length : 0;
            return (
              <li key={condition.id} className={nodes === 0 ? 'entity broken' : 'entity'}>
                <div className="entity-head">
                  <input
                    type="checkbox"
                    checked={condition.enabled}
                    title="enabled"
                    onChange={(event) =>
                      dispatch({
                        type: 'bc/patch',
                        id: condition.id,
                        patch: { enabled: event.target.checked },
                      })
                    }
                  />
                  <button
                    type="button"
                    className="entity-name"
                    title="select this target"
                    onClick={() =>
                      dispatch({ type: 'view/setSelection', selection: [condition.target] })
                    }
                  >
                    {model ? describeTarget(model, condition.target) : condition.target.partId}
                  </button>
                  <button
                    type="button"
                    className="mini"
                    title="delete"
                    onClick={() => dispatch({ type: 'bc/remove', id: condition.id })}
                  >
                    ✕
                  </button>
                </div>
                <div className="entity-body">
                  {condition.kind === 'fixedTemp' ? (
                    <NumberField
                      label="temperature"
                      suffix="°C"
                      value={kelvinToCelsius(condition.value)}
                      onCommit={(celsius) =>
                        dispatch({
                          type: 'bc/patch',
                          id: condition.id,
                          patch: { value: celsiusToKelvin(celsius) },
                        })
                      }
                    />
                  ) : null}
                  {condition.kind === 'heatLoad' ? (
                    <NumberField
                      label="power"
                      suffix="W"
                      value={condition.watts}
                      onCommit={(watts) =>
                        dispatch({ type: 'bc/patch', id: condition.id, patch: { watts } })
                      }
                      title="Total watts spread over the target"
                    />
                  ) : null}
                  {condition.kind === 'convection' ? (
                    <div className="row">
                      <NumberField
                        label="h"
                        suffix="W/m²·K"
                        value={condition.h === 'auto' ? 0 : condition.h}
                        disabled={condition.h === 'auto'}
                        onCommit={(h) =>
                          dispatch({ type: 'bc/patch', id: condition.id, patch: { h } })
                        }
                      />
                      <button
                        type="button"
                        className={condition.h === 'auto' ? 'on' : undefined}
                        onClick={() =>
                          dispatch({
                            type: 'bc/patch',
                            id: condition.id,
                            patch: { h: condition.h === 'auto' ? 10 : 'auto' },
                          })
                        }
                        title="Use the natural-convection correlation instead of a fixed film coefficient"
                      >
                        auto
                      </button>
                    </div>
                  ) : null}
                  <span className="muted">
                    {condition.kind} · {nodes} node{nodes === 1 ? '' : 's'}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
