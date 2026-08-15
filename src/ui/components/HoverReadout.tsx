/**
 * The floating readout that follows the cursor, as in the prototype: temperature at
 * the point under the pointer, plus what and where it is.
 *
 * Subscribes to the hover store directly so a pointer move re-renders this and
 * nothing else.
 */

import type { ThermalModel } from '@/core/types';
import { kelvinToCelsius } from '@/core/units';
import { useHover, type HoverStore } from '../state/hoverStore';

const OFFSET_PX = 14;

export interface HoverReadoutProps {
  store: HoverStore;
  model: ThermalModel | null;
  /** True once a field exists; before that the readout says so instead of showing nothing. */
  hasField: boolean;
}

export function HoverReadout({ store, model, hasField }: HoverReadoutProps) {
  const hover = useHover(store);
  if (!hover || !hover.hit || !model) return null;

  const { hit } = hover;
  const part = model.parts.find((candidate) => candidate.id === hit.partId);
  const temperature = hit.temperature;
  // Keep the box inside the window; near the right edge it flips to the left of the cursor.
  const flip = hover.x > window.innerWidth - 220;
  const style: React.CSSProperties = {
    left: flip ? undefined : hover.x + OFFSET_PX,
    right: flip ? window.innerWidth - hover.x + OFFSET_PX : undefined,
    top: Math.min(hover.y + OFFSET_PX, window.innerHeight - 90),
  };

  return (
    <div className="readout" style={style}>
      <div className="readout-temp">
        {hasField && temperature !== null && Number.isFinite(temperature)
          ? `${kelvinToCelsius(temperature).toFixed(1)} °C`
          : 'no field'}
      </div>
      <div className="readout-line">{part?.name ?? hit.partId}</div>
      <div className="readout-line muted">
        face {hit.faceId} · node {hit.nodeIndex}
        {hit.edgeId !== null ? ` · edge ${hit.edgeId}` : ''}
      </div>
      <div className="readout-line muted">
        {hit.point.map((value) => (value * 1000).toFixed(1)).join(', ')} mm
      </div>
    </div>
  );
}
