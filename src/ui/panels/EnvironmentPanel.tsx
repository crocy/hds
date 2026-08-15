/**
 * Ambient conditions and solver settings — everything about the environment the
 * assembly sits in rather than the assembly itself.
 */

import type { Vec3 } from '@/core/types';
import { celsiusToKelvin, kelvinToCelsius } from '@/core/units';
import { Panel } from '../components/Panel';
import { ButtonGroup, CheckField, Hint, NumberField } from '../components/fields';
import { useDispatch, useProject } from '../state/projectStore';

type GravityKey = '-z' | '+z' | '-y' | '+y' | '-x' | '+x';

const GRAVITY_VECTORS: Record<GravityKey, Vec3> = {
  '-z': [0, 0, -1],
  '+z': [0, 0, 1],
  '-y': [0, -1, 0],
  '+y': [0, 1, 0],
  '-x': [-1, 0, 0],
  '+x': [1, 0, 0],
};

export function EnvironmentPanel() {
  const { scenario } = useProject();
  const dispatch = useDispatch();
  const { solver } = scenario;
  const gravityKey =
    (Object.keys(GRAVITY_VECTORS) as GravityKey[]).find((key) =>
      sameVector(GRAVITY_VECTORS[key], scenario.gravity),
    ) ?? '-z';

  return (
    <Panel title="Ambient & solver" defaultOpen={false}>
      <NumberField
        label="ambient"
        suffix="°C"
        value={kelvinToCelsius(scenario.ambient)}
        onCommit={(celsius) =>
          dispatch({ type: 'scenario/setAmbient', ambient: celsiusToKelvin(celsius) })
        }
        title="Air temperature the model convects and radiates to"
      />
      <div className="row spread">
        <span className="field-label">down is</span>
        <ButtonGroup
          value={gravityKey}
          options={(Object.keys(GRAVITY_VECTORS) as GravityKey[]).map((key) => ({
            value: key,
            label: key,
          }))}
          onChange={(key) =>
            dispatch({ type: 'scenario/setGravity', gravity: GRAVITY_VECTORS[key] })
          }
        />
      </div>
      <Hint>Buoyancy: a surface facing down convects less than the same surface facing up.</Hint>

      <NumberField
        label="tolerance"
        suffix="K"
        min={1e-6}
        value={solver.tolerance}
        onCommit={(tolerance) => dispatch({ type: 'scenario/setSolver', patch: { tolerance } })}
        title="Outer Picard loop stops below this maximum change in node temperature"
      />
      <NumberField
        label="max outer"
        min={1}
        precision={0}
        value={solver.maxOuterIterations}
        onCommit={(maxOuterIterations) =>
          dispatch({ type: 'scenario/setSolver', patch: { maxOuterIterations } })
        }
      />
      <NumberField
        label="CG tolerance"
        min={1e-14}
        value={solver.cgTolerance}
        onCommit={(cgTolerance) => dispatch({ type: 'scenario/setSolver', patch: { cgTolerance } })}
      />
      <NumberField
        label="max CG"
        min={1}
        precision={0}
        value={solver.maxCgIterations}
        onCommit={(maxCgIterations) =>
          dispatch({ type: 'scenario/setSolver', patch: { maxCgIterations } })
        }
      />
      <CheckField
        label="warm start from the last solution"
        checked={solver.warmStart}
        onChange={(warmStart) => dispatch({ type: 'scenario/setSolver', patch: { warmStart } })}
      />
    </Panel>
  );
}

function sameVector(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
