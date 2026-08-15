/**
 * The cut plane: where it is, whether it clips, and the 2D field solved on it.
 *
 * The filled field ignores out-of-plane conduction — it is a Laplace solve inside the
 * cut outline, not a slice of a volumetric answer — and says so here rather than
 * letting the picture imply more than it means.
 */

import type { SectionAxis } from '@/viewer';
import { Panel } from '../components/Panel';
import { ButtonGroup, CheckField, Hint, NumberField, SliderField } from '../components/fields';
import { useDispatch, useProject } from '../state/projectStore';

export interface SectionPanelProps {
  offsetRange: { min: number; max: number };
  /** One line describing the last slice solve, or why there is none. */
  fieldStatus: string;
}

const AXES: ReadonlyArray<{ value: SectionAxis; label: string }> = [
  { value: 'x', label: 'x' },
  { value: 'y', label: 'y' },
  { value: 'z', label: 'z' },
];

const RESOLUTIONS = [128, 192, 256] as const;

export function SectionPanel({ offsetRange, fieldStatus }: SectionPanelProps) {
  const { viewer, model } = useProject();
  const dispatch = useDispatch();
  const section = viewer.section;
  const offset = section.offset ?? (offsetRange.min + offsetRange.max) / 2;

  const patch = (value: Partial<typeof section>) =>
    dispatch({ type: 'view/patchSection', patch: value });

  return (
    <Panel
      title="Section"
      defaultOpen={false}
      badge={section.enabled ? 'on' : undefined}
      actions={
        <button
          type="button"
          className={section.enabled ? 'on' : undefined}
          disabled={!model}
          onClick={() => patch({ enabled: !section.enabled })}
        >
          {section.enabled ? 'hide' : 'show'}
        </button>
      }
    >
      <div className="row spread">
        <span className="field-label">normal</span>
        <ButtonGroup
          value={section.axis}
          options={AXES}
          disabled={!section.enabled}
          onChange={(axis) => patch({ axis })}
        />
        <button
          type="button"
          disabled={!section.enabled}
          title="Flip which side is kept"
          onClick={() => patch({ sign: section.sign === 1 ? -1 : 1 })}
        >
          {section.sign === 1 ? '+' : '−'}
        </button>
      </div>
      <SliderField
        label="offset"
        min={offsetRange.min}
        max={offsetRange.max}
        step={Math.max((offsetRange.max - offsetRange.min) / 400, 1e-6)}
        value={offset}
        disabled={!section.enabled}
        onChange={(value) => patch({ offset: value })}
      />
      <NumberField
        label="offset"
        suffix="mm"
        value={offset * 1000}
        disabled={!section.enabled}
        onCommit={(mm) => patch({ offset: mm / 1000 })}
      />
      <CheckField
        label="clip the model at the plane"
        checked={section.clipping}
        disabled={!section.enabled}
        onChange={(clipping) => patch({ clipping })}
      />
      <CheckField
        label="solve and draw the 2D field"
        checked={section.showField}
        disabled={!section.enabled}
        onChange={(showField) => patch({ showField })}
      />
      <div className="row spread">
        <span className="field-label">grid</span>
        <ButtonGroup
          value={String(section.resolution)}
          options={RESOLUTIONS.map((value) => ({ value: String(value), label: `${value}²` }))}
          disabled={!section.enabled || !section.showField}
          onChange={(value) => patch({ resolution: Number(value) })}
        />
      </div>
      <Hint>{fieldStatus}</Hint>
      <Hint>
        The filled field is a 2D Laplace solve inside the cut outline. It ignores conduction through
        the plane, so read it as indicative.
      </Hint>
    </Panel>
  );
}
