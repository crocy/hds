/**
 * The colour scale, in °C.
 *
 * The user asked to be able to put the gradient anywhere between the model's maximum
 * and the ambient minimum, so both ends are directly typed and dragged here rather
 * than being a consequence of a preset. `auto` and `ambient → max` are shortcuts, not
 * the only way in: touching either slider switches the scale to manual and keeps the
 * numbers the user just set.
 */

import type { ColorScale, ColormapId } from '@/core/types';
import { celsiusToKelvin, kelvinToCelsius } from '@/core/units';
import {
  COLORMAP_IDS,
  COLORMAP_LABELS,
  gradientCss,
  isDiverging,
  type ResolvedColorScale,
} from '@/viewer';
import { Panel } from '../components/Panel';
import { ButtonGroup, Hint, NumberField, SliderField } from '../components/fields';
import { useDispatch, useProject } from '../state/projectStore';

export interface ColorScalePanelProps {
  /** What the viewer actually shaded with — the resolved range, not the stored one. */
  resolved: ResolvedColorScale;
}

const MODES: ReadonlyArray<{ value: ColorScale['mode']; label: string; title: string }> = [
  { value: 'auto', label: 'auto', title: 'The solved range' },
  { value: 'ambientToMax', label: 'ambient → max', title: 'From ambient to the hottest node' },
  { value: 'manual', label: 'manual', title: 'Exactly the numbers below' },
];

export function ColorScalePanel({ resolved }: ColorScalePanelProps) {
  const { scenario, solve } = useProject();
  const dispatch = useDispatch();
  const scale = scenario.colorScale;
  const ambient = scenario.ambient;
  const result = solve.result;

  // Slider bounds: everything the user could reasonably want to see, from the
  // coldest of (ambient, field) to the hottest, with a little air at both ends.
  const fieldMin = result ? Math.min(result.minTemp, ambient) : ambient - 10;
  const fieldMax = result ? Math.max(result.maxTemp, ambient + 1) : ambient + 100;
  const pad = Math.max(1, (fieldMax - fieldMin) * 0.1);
  const lowerBound = kelvinToCelsius(fieldMin - pad);
  const upperBound = kelvinToCelsius(fieldMax + pad);

  const minC = kelvinToCelsius(resolved.min);
  const maxC = kelvinToCelsius(resolved.max);

  const setRange = (patch: { min?: number; max?: number }) => {
    const min = patch.min ?? resolved.min;
    const max = patch.max ?? resolved.max;
    dispatch({
      type: 'scenario/setColorScale',
      patch: { mode: 'manual', min: Math.min(min, max - 0.01), max: Math.max(max, min + 0.01) },
    });
  };

  const straddlesAmbient =
    result !== null && result.minTemp < ambient - 0.5 && result.maxTemp > ambient + 0.5;

  return (
    <Panel title="Colour scale">
      <ButtonGroup
        value={scale.mode}
        options={MODES}
        onChange={(mode) => dispatch({ type: 'scenario/setColorScale', patch: { mode } })}
      />
      <div className="row">
        <NumberField
          label="min"
          suffix="°C"
          value={minC}
          precision={1}
          onCommit={(celsius) => setRange({ min: celsiusToKelvin(celsius) })}
        />
        <NumberField
          label="max"
          suffix="°C"
          value={maxC}
          precision={1}
          onCommit={(celsius) => setRange({ max: celsiusToKelvin(celsius) })}
        />
      </div>
      <SliderField
        label="min"
        min={lowerBound}
        max={upperBound}
        step={0.5}
        value={minC}
        onChange={(celsius) => setRange({ min: celsiusToKelvin(celsius) })}
      />
      <SliderField
        label="max"
        min={lowerBound}
        max={upperBound}
        step={0.5}
        value={maxC}
        onChange={(celsius) => setRange({ max: celsiusToKelvin(celsius) })}
      />
      <div className="row">
        <button
          type="button"
          onClick={() =>
            setRange({ min: ambient, max: result ? result.maxTemp : celsiusToKelvin(maxC) })
          }
          title="Ambient at the bottom, the hottest node at the top, as fixed numbers"
        >
          ambient → max
        </button>
        <button
          type="button"
          disabled={!result}
          onClick={() => result && setRange({ min: result.minTemp, max: result.maxTemp })}
        >
          field range
        </button>
      </div>

      <div className="colormaps">
        {COLORMAP_IDS.map((map) => (
          <button
            key={map}
            type="button"
            className={`colormap${scale.map === map ? ' on' : ''}`}
            title={COLORMAP_LABELS[map]}
            onClick={() => dispatch({ type: 'scenario/setColorScale', patch: { map } })}
          >
            <span style={{ background: gradientCss(map) }} />
            {map}
          </button>
        ))}
      </div>

      {straddlesAmbient && !isDiverging(scale.map) ? (
        <button
          type="button"
          className="suggestion"
          onClick={() =>
            dispatch({
              type: 'scenario/setColorScale',
              patch: { map: 'coolwarm' as ColormapId },
            })
          }
        >
          The field crosses ambient — switch to the diverging map
        </button>
      ) : null}
      <Hint>
        Showing {minC.toFixed(1)} to {maxC.toFixed(1)} °C
        {result
          ? ` · field ${kelvinToCelsius(result.minTemp).toFixed(1)} to ${kelvinToCelsius(result.maxTemp).toFixed(1)} °C`
          : ' · no field yet'}
        {isDiverging(scale.map) && scale.mode !== 'manual'
          ? ' · centred on ambient for the diverging map'
          : ''}
      </Hint>
    </Panel>
  );
}
