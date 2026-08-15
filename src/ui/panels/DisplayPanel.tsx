/**
 * What is drawn on top of the shaded mesh: wireframe and the scenario overlays.
 * Each overlay's swatch is the colour it is actually drawn in.
 */

import { OVERLAY_COLORS, OVERLAY_KINDS, OVERLAY_LABELS } from '@/viewer';
import { Panel } from '../components/Panel';
import { CheckField } from '../components/fields';
import { useDispatch, useProject } from '../state/projectStore';

export interface DisplayPanelProps {
  onResetView(): void;
}

export function DisplayPanel({ onResetView }: DisplayPanelProps) {
  const { viewer } = useProject();
  const dispatch = useDispatch();

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
