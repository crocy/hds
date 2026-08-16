/**
 * How things are drawn: the theme the whole app is rendered in, then what sits on top
 * of the shaded mesh — wireframe and the scenario overlays.
 * Each overlay's swatch is the colour it is actually drawn in.
 */

import { useId } from 'react';
import { THEME_MODES, useTheme } from '@/ui/theme';
import { OVERLAY_COLORS, OVERLAY_KINDS, OVERLAY_LABELS } from '@/viewer';
import { Panel } from '../components/Panel';
import { ButtonGroup, CheckField, Hint } from '../components/fields';
import { useDispatch, useProject } from '../state/projectStore';

/** Derived from the mode list rather than written out, so the control cannot drift from the type. */
const THEME_OPTIONS = THEME_MODES.map((mode) => ({ value: mode, label: mode }));

export interface DisplayPanelProps {
  onResetView(): void;
}

export function DisplayPanel({ onResetView }: DisplayPanelProps) {
  const { viewer } = useProject();
  const dispatch = useDispatch();
  const { mode, resolved, setMode } = useTheme();
  const themeLabelId = useId();

  return (
    <Panel
      title="Display"
      defaultOpen={false}
      actions={
        <button type="button" onClick={onResetView} title="Frame the whole model (hotkey f)">
          reset view
        </button>
      }
    >
      <div className="row spread" role="group" aria-labelledby={themeLabelId}>
        <span className="field-label" id={themeLabelId}>
          theme
        </span>
        <ButtonGroup value={mode} options={THEME_OPTIONS} onChange={setMode} />
      </div>
      {mode === 'system' ? <Hint>Following the OS setting, currently {resolved}.</Hint> : null}
      <CheckField
        label="wireframe (w)"
        checked={viewer.wireframe}
        onChange={(wireframe) => dispatch({ type: 'view/setWireframe', wireframe })}
      />
      {OVERLAY_KINDS.map((kind) => (
        <CheckField
          key={kind}
          checked={viewer.overlays[kind]}
          onChange={(visible) => dispatch({ type: 'view/setOverlay', kind, visible })}
          label={
            <>
              <span
                className="swatch"
                style={{ background: `#${OVERLAY_COLORS[kind].toString(16).padStart(6, '0')}` }}
              />
              {OVERLAY_LABELS[kind]}
            </>
          }
        />
      ))}
    </Panel>
  );
}
