/**
 * One boundary condition: its group's composition, its value, and the members the
 * group is made of.
 *
 * The member list is where a group is audited — it says how many nodes each member
 * actually contributes, so an overlapped member reads as covered instead of looking
 * like extra area, a member on an insulating part says the solve leaves it out, and a
 * member whose geometry is gone reads as zero rather than quietly doing nothing.
 */

import type { BoundaryCondition, Scenario, Target, ThermalModel } from '@/core/types';
import { celsiusToKelvin, kelvinToCelsius } from '@/core/units';
import { targetsEqual } from '@/core/targets';
import { describeTarget } from '@/viewer';
import { NumberField } from '../components/fields';
import { summariseConditionTargets, type ConditionMember } from '../state/conditionTargets';
import { formatWatts } from '../state/format';
import { useDispatch } from '../state/projectStore';

export interface BoundaryConditionRowProps {
  condition: BoundaryCondition;
  model: ThermalModel | null;
  /** Read for its part overrides: a part overridden to `insulator` carries nothing. */
  scenario: Scenario;
  /** The panel's staged group, which `add staged` folds into this condition. */
  draft: readonly Target[];
}

export function BoundaryConditionRow({
  condition,
  model,
  scenario,
  draft,
}: BoundaryConditionRowProps) {
  const dispatch = useDispatch();
  const summary = summariseConditionTargets(model, scenario, condition, (target) =>
    model ? describeTarget(model, target) : target.partId,
  );
  const lastMember = condition.targets.length === 1;

  const setTargets = (targets: Target[]) =>
    dispatch({ type: 'bc/setTargets', id: condition.id, targets });

  return (
    <li className={summary.nodeCount === 0 ? 'entity broken' : 'entity'}>
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
          title="select every target in this group"
          onClick={() => dispatch({ type: 'view/setSelection', selection: [...condition.targets] })}
        >
          {summary.label}
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
            onCommit={(watts) => dispatch({ type: 'bc/patch', id: condition.id, patch: { watts } })}
            title="Total watts spread over the whole group"
          />
        ) : null}
        {condition.kind === 'convection' ? (
          <div className="row">
            <NumberField
              label="h"
              suffix="W/m²·K"
              value={condition.h === 'auto' ? 0 : condition.h}
              disabled={condition.h === 'auto'}
              onCommit={(h) => dispatch({ type: 'bc/patch', id: condition.id, patch: { h } })}
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
          {condition.kind} · {summary.nodeCount} node{summary.nodeCount === 1 ? '' : 's'}
        </span>

        <ul className="entity-sublist">
          {summary.members.map((member) => (
            <li key={member.key} className="subentity">
              <div className="entity-head">
                <span className="member-name">{member.label}</span>
                <span className="muted">{memberMetric(member)}</span>
                <button
                  type="button"
                  className="mini"
                  disabled={lastMember}
                  title={
                    lastMember
                      ? 'The last target — delete the whole condition instead'
                      : 'remove this target from the group'
                  }
                  onClick={() =>
                    setTargets(
                      condition.targets.filter((target) => !targetsEqual(target, member.target)),
                    )
                  }
                >
                  ✕
                </button>
              </div>
              {member.covered ? <span className="muted">covered by an earlier member</span> : null}
              {member.insulating ? (
                <span className="muted">insulating — the solve leaves this part out</span>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="row end">
          <button
            type="button"
            className="mini"
            disabled={draft.length === 0}
            title="Fold the staged targets into this group"
            onClick={() => {
              setTargets([...condition.targets, ...draft]);
              dispatch({ type: 'view/setBcDraft', targets: [] });
            }}
          >
            add staged{draft.length > 0 ? ` (${draft.length})` : ''}
          </button>
        </div>
      </div>
    </li>
  );
}

function memberMetric(member: ConditionMember): string {
  const nodes = `${member.nodeCount} node${member.nodeCount === 1 ? '' : 's'}`;
  if (member.watts === null) return nodes;
  return `${nodes} · ${member.nodeCount > 0 ? formatWatts(member.watts) : '—'}`;
}
