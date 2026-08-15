/**
 * Surface area by temperature — spec §7.4. "X cm² exceeds 55 °C", with the
 * histogram behind the number.
 *
 * Each bar is filled with the colour its own temperature has in the 3D view, so
 * the histogram reads as the same field seen a different way rather than as an
 * unrelated chart. Bars below the threshold are dimmed, which makes the answer
 * legible without a second encoding.
 */

import { useMemo, useRef } from 'react';
import type { ColormapId, ThresholdResult } from '@/core/types';
import { ABSOLUTE_ZERO_C } from '@/core/units';
import { cssColor, normalize } from '@/viewer/colormap';
import { PlotAxes, PlotFrame, PlotSurface, ThresholdMarker } from './PlotFrame';
import {
  formatCelsius,
  formatCelsiusWithUnit,
  formatFixed,
  formatPercent,
  formatSquareCentimetres,
  squareMetresToSquareCentimetres,
} from './format';
import {
  computePlotGeometry,
  DEFAULT_PLOT_MARGINS,
  decimalsForTicks,
  finiteExtent,
  generateTicks,
  includeInInterval,
  type Interval,
  niceInterval,
} from './scales';
import { useElementSize } from './useElementSize';
import './plots.css';

const HISTOGRAM_MARGINS = { ...DEFAULT_PLOT_MARGINS, left: 58 };
/** Bars under the limit are still data, just not the answer. */
const BELOW_THRESHOLD_OPACITY = 0.42;
/**
 * The cold end of every thermal colormap is near-black, which on a near-black
 * panel would erase the tallest bars. A hairline keeps their extent readable
 * without adding a second colour encoding.
 */
const BAR_EDGE = 'rgba(232, 234, 240, 0.22)';

export interface ThresholdPlotProps {
  result: ThresholdResult | null;
  colorMap?: ColormapId;
  /** kelvin. Colour range for the bars; defaults to the histogram's own extent. */
  colorRange?: readonly [number, number] | null;
  /** partId → display name for the breakdown. Falls back to the id. */
  partNames?: Readonly<Record<string, string>>;
  title?: string;
  xLabel?: string;
  yLabel?: string;
  height?: number | string;
  className?: string;
}

export function ThresholdPlot({
  result,
  colorMap = 'inferno',
  colorRange,
  partNames,
  title = 'surface area by temperature',
  xLabel = 'temperature  [°C]',
  yLabel = 'surface area  [cm²]',
  height,
  className,
}: ThresholdPlotProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(bodyRef);

  const bars = useMemo(() => (result ? buildBars(result) : []), [result]);

  const xDomain = useMemo(() => {
    if (!result || bars.length === 0) return { min: 0, max: 1 };
    const edges = result.histogram.binEdges;
    let span: Interval = {
      min: edges[0] + ABSOLUTE_ZERO_C,
      max: edges[edges.length - 1] + ABSOLUTE_ZERO_C,
    };
    // A limit nobody's surface reaches is the most important case to show: the
    // reader has to see that the threshold sits off the end of the distribution.
    span = includeInInterval(span, result.threshold + ABSOLUTE_ZERO_C);
    return niceInterval(span.min, span.max, 6);
  }, [result, bars.length]);

  const yDomain = useMemo(() => {
    const peak = finiteExtent(bars.map((bar) => bar.areaCm2));
    return niceInterval(0, peak && peak.max > 0 ? peak.max : 1, 5);
  }, [bars]);

  const geometry = useMemo(
    () => computePlotGeometry(size.width, size.height, HISTOGRAM_MARGINS, xDomain, yDomain),
    [size.width, size.height, xDomain, yDomain],
  );

  const colorMin = colorRange ? colorRange[0] : (result?.histogram.binEdges[0] ?? 0);
  const colorMax = colorRange
    ? colorRange[1]
    : (result?.histogram.binEdges[result.histogram.binEdges.length - 1] ?? 1);

  const totalArea = result?.totalArea ?? 0;
  const fractionAbove = totalArea > 0 ? (result?.areaAbove ?? 0) / totalArea : 0;

  const empty = !result
    ? NO_SOLVE
    : bars.length === 0
      ? NO_BINS
      : totalArea <= 0
        ? NO_SURFACE
        : null;

  const xTicks = geometry ? generateTicks(xDomain.min, xDomain.max, 6) : [];
  const yTicks = geometry ? generateTicks(yDomain.min, yDomain.max, 5) : [];
  const xDecimals = decimalsForTicks(xTicks);
  const yDecimals = decimalsForTicks(yTicks);

  const contributors =
    result?.perPart
      .filter((part) => part.areaAbove > 0)
      .sort((a, b) => b.areaAbove - a.areaAbove) ?? [];

  return (
    <PlotFrame
      title={title}
      note={
        result ? (
          <>
            <strong>{formatSquareCentimetres(result.areaAbove)}</strong> above{' '}
            <strong>{formatCelsiusWithUnit(result.threshold)}</strong>
            {totalArea > 0 &&
              ` · ${formatPercent(fractionAbove, 1)} of ${formatSquareCentimetres(totalArea)}`}
            {contributors.length > 0 && (
              <>
                {' · '}
                {contributors
                  .slice(0, 3)
                  .map(
                    (part) =>
                      `${partNames?.[part.partId] ?? part.partId} ${formatSquareCentimetres(part.areaAbove)}`,
                  )
                  .join(', ')}
                {contributors.length > 3 && ` +${contributors.length - 3} more`}
              </>
            )}
          </>
        ) : null
      }
      summary={
        result
          ? `${formatSquareCentimetres(result.areaAbove)} of surface is above ${formatCelsiusWithUnit(result.threshold)}, out of ${formatSquareCentimetres(totalArea)} total.`
          : 'Surface area by temperature. No data.'
      }
      bodyRef={bodyRef}
      empty={empty}
      className={className}
      height={height}
    >
      {geometry && !empty && result && (
        <PlotSurface geometry={geometry}>
          <PlotAxes
            geometry={geometry}
            xTicks={xTicks}
            yTicks={yTicks}
            formatXTick={(value) => formatFixed(value, xDecimals)}
            formatYTick={(value) => formatFixed(value, yDecimals)}
            xLabel={xLabel}
            yLabel={yLabel}
            grid="y"
          />
          {bars.map((bar) => {
            const left = geometry.px(bar.fromCelsius);
            const right = geometry.px(bar.toCelsius);
            const top = geometry.py(bar.areaCm2);
            const base = geometry.py(0);
            const width = Math.max(0, right - left);
            const barHeight = Math.max(0, base - top);
            if (width <= 0 || barHeight <= 0) return null;
            const above = bar.centreKelvin >= result.threshold;
            return (
              <rect
                key={bar.index}
                x={left}
                y={top}
                width={width}
                height={barHeight}
                fill={cssColor(colorMap, normalize(bar.centreKelvin, colorMin, colorMax))}
                stroke={BAR_EDGE}
                strokeWidth={0.5}
                opacity={above ? 1 : BELOW_THRESHOLD_OPACITY}
              />
            );
          })}
          <ThresholdMarker
            geometry={geometry}
            value={result.threshold + ABSOLUTE_ZERO_C}
            orientation="vertical"
            label={`${formatCelsius(result.threshold)} °C limit`}
          />
        </PlotSurface>
      )}
    </PlotFrame>
  );
}

const NO_SOLVE = 'No solve yet — run a solve to see how much surface sits above the limit.';
const NO_BINS = 'The histogram is empty.';
const NO_SURFACE = 'No triangle has a finite temperature, so there is no surface area to report.';

interface HistogramBar {
  index: number;
  fromCelsius: number;
  toCelsius: number;
  /** kelvin, for colouring and for the above/below test. */
  centreKelvin: number;
  areaCm2: number;
}

function buildBars(result: ThresholdResult): HistogramBar[] {
  const { binEdges, areaPerBin } = result.histogram;
  const count = Math.min(areaPerBin.length, Math.max(0, binEdges.length - 1));
  const bars: HistogramBar[] = [];
  for (let i = 0; i < count; i++) {
    const from = binEdges[i];
    const to = binEdges[i + 1];
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    bars.push({
      index: i,
      fromCelsius: from + ABSOLUTE_ZERO_C,
      toCelsius: to + ABSOLUTE_ZERO_C,
      centreKelvin: (from + to) / 2,
      areaCm2: squareMetresToSquareCentimetres(areaPerBin[i]),
    });
  }
  return bars;
}
