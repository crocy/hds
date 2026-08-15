/**
 * The colour bar, as in the prototype: gradient, tick labels in °C, and a marked
 * ambient line so "above ambient" is readable at a glance.
 */

import { gradientCss, normalize, type ResolvedColorScale } from '@/viewer';
import { kelvinToCelsius } from '@/core/units';

const TICK_COUNT = 5;

export interface LegendProps {
  scale: ResolvedColorScale;
  /** kelvin */
  ambient: number;
  label: string;
  /** Shown under the bar — the field's own range, when it differs from the scale. */
  note?: string;
}

export function Legend({ scale, ambient, label, note }: LegendProps) {
  const ticks = Array.from({ length: TICK_COUNT }, (_, index) => {
    const t = index / (TICK_COUNT - 1);
    return scale.min + (scale.max - scale.min) * t;
  });
  const ambientFraction = normalize(ambient, scale.min, scale.max);
  const showAmbient = ambient > scale.min && ambient < scale.max;

  return (
    <div className="panel legend">
      <div className="legend-label">{label}</div>
      <div className="legend-bar" style={{ background: gradientCss(scale.map) }}>
        {showAmbient ? (
          <span
            className="legend-ambient"
            style={{ left: `${ambientFraction * 100}%` }}
            title={`ambient ${kelvinToCelsius(ambient).toFixed(1)} °C`}
          />
        ) : null}
      </div>
      <div className="legend-ticks">
        {ticks.map((value, index) => (
          <span key={index}>{kelvinToCelsius(value).toFixed(index === 0 ? 1 : 1)}</span>
        ))}
      </div>
      <div className="legend-foot">
        <span>°C</span>
        {note ? <span className="muted">{note}</span> : null}
      </div>
    </div>
  );
}
