/**
 * Cavities — trapped volumes whose surfaces cannot see ambient.
 *
 * A sealed housing loses far less than its raw surface area suggests, so what is
 * inside and what is outside is one of the largest levers on the answer. Detection
 * is a vote over sampled rays and can be wrong, so faces can be reassigned by hand.
 */

import type { CavityCondition } from '@/core/types';
import { assignFaceRegionCavity } from '@/geometry/cavity';
import { Panel } from '../components/Panel';
import { EmptyState, Hint, NumberField, SelectField } from '../components/fields';
import { useDispatch, useProject } from '../state/projectStore';

const CONDITIONS: ReadonlyArray<{ value: CavityCondition; label: string }> = [
  { value: 'stillAir', label: 'still air (trapped)' },
  { value: 'insulated', label: 'insulated (foam or wool)' },
  { value: 'adiabatic', label: 'adiabatic (no exchange)' },
];

export function CavitiesPanel() {
  const { model, scenario, viewer } = useProject();
  const dispatch = useDispatch();
  const cavities = scenario.cavities;
  const faceTarget = viewer.selection.find((target) => target.type === 'face');

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
          {cavities.map((cavity) => (
            <li key={cavity.id} className="entity">
              <div className="entity-head">
                <span className="entity-name">{cavity.name}</span>
                <span className="muted">{cavity.triCount} tris</span>
              </div>
              <div className="entity-body">
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
          ))}
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
