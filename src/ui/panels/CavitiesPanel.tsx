/**
 * Cavities — trapped volumes whose surfaces cannot see ambient.
 *
 * A sealed housing loses far less than its raw surface area suggests, so what is
 * inside and what is outside is one of the largest levers on the answer. Detection
 * is a vote over sampled rays and can be wrong, so faces can be reassigned by hand.
 *
 * The solved trapped-air temperature is read here too, beside the conditions that
 * produced it, with the net flow the balance found across the pocket's walls. Heat
 * entering a sealed pocket has to leave again, so that flow must come out ~0; showing
 * it is what lets a user see that the pocket closed rather than take it on trust.
 */

import type { CavityCondition } from '@/core/types';
import { assignFaceRegionCavity } from '@/geometry/cavity';
import { Panel } from '../components/Panel';
import { EmptyState, Hint, NumberField, SelectField } from '../components/fields';
import { cavityAirStates, formatShareOfThroughput, type CavityAirState } from '../state/cavityAir';
import { formatCelsius, formatWatts } from '../state/format';
import { useDispatch, useProject } from '../state/projectStore';

const CONDITIONS: ReadonlyArray<{ value: CavityCondition; label: string }> = [
  { value: 'stillAir', label: 'still air (trapped)' },
  { value: 'insulated', label: 'insulated (foam or wool)' },
  { value: 'adiabatic', label: 'adiabatic (no exchange)' },
];

export function CavitiesPanel() {
  const { model, scenario, viewer, solve } = useProject();
  const dispatch = useDispatch();
  const cavities = scenario.cavities;
  const faceTarget = viewer.selection.find((target) => target.type === 'face');
  const airStates = cavityAirStates(cavities, solve.result?.balance ?? null);
  const leaking = [...airStates.values()].some(
    (air) => air.kind === 'solved' && air.severity !== 'ok',
  );

  const assignFace = (cavityId: number) => {
    if (!model || !faceTarget || faceTarget.type !== 'face') return;
    const partIndex = model.parts.findIndex((part) => part.id === faceTarget.partId);
    if (partIndex < 0) return;
    // assignFaceRegionCavity writes triCavity in place and recounts the cavities it
    // is handed, so it gets copies and the model revision is bumped afterwards.
    const next = cavities.map((cavity) => ({ ...cavity }));
    assignFaceRegionCavity(model, next, partIndex, faceTarget.faceId, cavityId);
    dispatch({ type: 'cavities/replace', cavities: next });
    dispatch({ type: 'model/mutated' });
  };

  return (
    <Panel
      title="Cavities"
      defaultOpen={false}
      badge={cavities.length || undefined}
      tone={leaking ? 'warning' : 'default'}
      actions={
        <button
          type="button"
          className={viewer.overlays.cavities ? 'on' : undefined}
          onClick={() =>
            dispatch({
              type: 'view/setOverlay',
              kind: 'cavities',
              visible: !viewer.overlays.cavities,
            })
          }
        >
          overlay
        </button>
      }
    >
      {cavities.length === 0 ? (
        <EmptyState>No enclosed cavities detected; every surface can see ambient.</EmptyState>
      ) : (
        <ul className="entity-list">
          {cavities.map((cavity) => {
            const air = airStates.get(cavity.id) ?? UNSOLVED_AIR;
            const notPhysical = air.kind === 'solved' && air.severity === 'bad';
            return (
              <li key={cavity.id} className={notPhysical ? 'entity broken' : 'entity'}>
                <div className="entity-head">
                  <span className="entity-name">{cavity.name}</span>
                  <span className="muted">{cavity.triCount} tris</span>
                </div>
                <div className="entity-body">
                  <CavityAirReadout air={air} />
                  <SelectField
                    value={cavity.condition}
                    options={CONDITIONS}
                    onChange={(condition) =>
                      dispatch({ type: 'cavities/setCondition', id: cavity.id, condition })
                    }
                    title="Switching this resets h, emissivity and fill conductivity to that condition's defaults"
                  />
                  <div className="row">
                    <NumberField
                      label="h"
                      suffix="W/m²·K"
                      min={0}
                      value={cavity.h}
                      onCommit={(h) =>
                        dispatch({ type: 'cavities/patch', id: cavity.id, patch: { h } })
                      }
                    />
                    <NumberField
                      label="ε"
                      min={0}
                      max={1}
                      step={0.05}
                      value={cavity.emissivity}
                      onCommit={(emissivity) =>
                        dispatch({ type: 'cavities/patch', id: cavity.id, patch: { emissivity } })
                      }
                    />
                    <NumberField
                      label="fill k"
                      suffix="W/m·K"
                      min={0}
                      value={cavity.fillK}
                      onCommit={(fillK) =>
                        dispatch({ type: 'cavities/patch', id: cavity.id, patch: { fillK } })
                      }
                      title="Only used by the 2D cut-plane fill"
                    />
                  </div>
                  {faceTarget ? (
                    <button type="button" onClick={() => assignFace(cavity.id)}>
                      move selected face here
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {faceTarget ? (
        <button type="button" onClick={() => assignFace(0)}>
          selected face is open air
        </button>
      ) : (
        <Hint>Select a face (mode 2) to reassign it between cavities and open air.</Hint>
      )}
    </Panel>
  );
}

const UNSOLVED_AIR: CavityAirState = { kind: 'unsolved' };

/**
 * A net flow into a sealed pocket is not a tolerance to live with — it is heat the
 * solve put somewhere it cannot be — so the note says what it means for the result.
 */
const NET_FLOW_MESSAGE = {
  warn: 'This pocket is not quite closing. Tighten the solver tolerance.',
  bad: 'A sealed pocket has nowhere to put a net flow; this field is not physical.',
} as const;

const ABSENT_AIR_TITLE = {
  unsolved: 'Run a solve to see the temperature of the air trapped in this cavity.',
  noAirNode:
    'An adiabatic cavity exchanges nothing with its walls, so the solve gives its air no temperature of its own.',
} as const;

function CavityAirReadout({ air }: { air: CavityAirState }) {
  if (air.kind !== 'solved') {
    return (
      <dl className="stats">
        <div>
          <dt>trapped air</dt>
          <dd className="muted" title={ABSENT_AIR_TITLE[air.kind]}>
            {air.kind === 'noAirNode' ? 'no air node' : 'not solved'}
          </dd>
        </div>
      </dl>
    );
  }

  // A model moving no power has no share to quote the net flow as, and "0 % of 0 mW"
  // would read as a measurement rather than as the absence of one.
  const share =
    air.throughput > 0
      ? ` · ${formatShareOfThroughput(air.flowFraction)} of ${formatWatts(air.throughput)}`
      : '';
  const against =
    air.throughput > 0
      ? `, against ${formatWatts(air.throughput)} moving through the model`
      : ', in a model moving no power worth comparing it to';

  return (
    <>
      <dl className="stats">
        <div>
          <dt>trapped air</dt>
          <dd>{formatCelsius(air.temperature)}</dd>
        </div>
        <div className={air.severity === 'ok' ? undefined : 'bad'}>
          <dt>net flow</dt>
          <dd
            title={`${formatWatts(air.netFlow)} net into the trapped air${against}. Added up from the solved field rather than read back off the matrix, so it is a check on the answer.`}
          >
            {air.severity === 'ok' ? `balanced${share}` : `${formatWatts(air.netFlow)}${share}`}
          </dd>
        </div>
      </dl>
      {air.severity === 'ok' ? null : (
        <span className="flag">⚠ {NET_FLOW_MESSAGE[air.severity]}</span>
      )}
    </>
  );
}
