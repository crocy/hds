/**
 * Temperature along the cut line — spec §7.1, bottom-right of the reference
 * figure.
 *
 * One line per part, a limit marker, and shaded spans for regions worth naming
 * ("controller cutout"). Section polylines run to a few thousand points at most,
 * so this stays entirely in SVG: crisp lines, and the geometry is inspectable.
 */

import { useMemo, useRef } from 'react';
import type { SectionPolyline } from '@/core/types';
import { ABSOLUTE_ZERO_C } from '@/core/units';
import {
  legendInset,
  PlotAxes,
  PlotFrame,
  PlotSurface,
  ThresholdMarker,
  polylinePath,
} from './PlotFrame';
import { formatCelsius, formatCelsiusWithUnit, formatFixed, metresToMillimetres } from './format';
import {
  computePlotGeometry,
  DEFAULT_PLOT_MARGINS,
  decimalsForTicks,
  finiteExtent,
  generateTicks,
  includeInInterval,
  type Interval,
  niceInterval,
  scaleOverRawUnits,
} from './scales';
import { PLOT_COLORS, seriesColor } from './theme';
import { useElementSize } from './useElementSize';
import './plots.css';

export interface ProfileSpan {
  id: string;
  /** Arc length bounds in metres, matching `SectionPolyline.arcLength`. */
  from: number;
  to: number;
  label?: string;
}

export interface SectionProfilePlotProps {
  polylines: readonly SectionPolyline[];
  /** partId → display name for the legend. Falls back to the id. */
  partNames?: Readonly<Record<string, string>>;
  /** kelvin */
  threshold?: number | null;
  thresholdLabel?: string;
  /** Shaded, labelled regions of the cut line. */
  spans?: readonly ProfileSpan[];
  title?: string;
  xLabel?: string;
  yLabel?: string;
  height?: number | string;
  className?: string;
}

export function SectionProfilePlot({
  polylines,
  partNames,
  threshold,
  thresholdLabel,
  spans,
  title = 'profile along the cut line',
  xLabel = 'distance along the section  [mm]',
  yLabel = 'temperature  [°C]',
  height,
  className,
}: SectionProfilePlotProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(bodyRef);

  // A part can cross the plane more than once; each loop is its own line but they
  // share one colour and one legend entry, because they are one part.
  const partOrder = useMemo(() => {
    const order = new Map<string, number>();
    for (const line of polylines) {
      if (!order.has(line.partId)) order.set(line.partId, order.size);
    }
    return order;
  }, [polylines]);

  const extent = useMemo(() => profileExtent(polylines), [polylines]);

  const xDomain = useMemo(
    () =>
      extent
        ? niceInterval(metresToMillimetres(extent.arc.min), metresToMillimetres(extent.arc.max), 6)
        : { min: 0, max: 1 },
    [extent],
  );

  const yDomain = useMemo(() => {
    if (!extent) return { min: 0, max: 1 };
    let span: Interval = {
      min: extent.temperature.min + ABSOLUTE_ZERO_C,
      max: extent.temperature.max + ABSOLUTE_ZERO_C,
    };
    if (threshold != null) span = includeInInterval(span, threshold + ABSOLUTE_ZERO_C);
    return niceInterval(span.min, span.max, 6);
  }, [extent, threshold]);

  const geometry = useMemo(
    () => computePlotGeometry(size.width, size.height, DEFAULT_PLOT_MARGINS, xDomain, yDomain),
    [size.width, size.height, xDomain, yDomain],
  );

  const empty = polylines.length === 0 ? NO_POLYLINES : !extent ? NO_FINITE_POINTS : null;

  const xTicks = geometry ? generateTicks(xDomain.min, xDomain.max, 6) : [];
  const yTicks = geometry ? generateTicks(yDomain.min, yDomain.max, 6) : [];
  const xDecimals = decimalsForTicks(xTicks);
  const yDecimals = decimalsForTicks(yTicks);

  const paths = useMemo(() => {
    if (!geometry) return [];
    const arcScale = scaleOverRawUnits(geometry.x, 1000, 0);
    const tempScale = scaleOverRawUnits(geometry.y, 1, ABSOLUTE_ZERO_C);
    return polylines.map((line, index) => ({
      key: `${line.partId}-${index}`,
      color: seriesColor(partOrder.get(line.partId) ?? index),
      d: polylinePath(interleave(line.arcLength, line.temperature), arcScale, tempScale),
    }));
  }, [geometry, polylines, partOrder]);

  return (
    <PlotFrame
      title={title}
      note={
        extent ? (
          <>
            <strong>{partOrder.size}</strong> {partOrder.size === 1 ? 'part' : 'parts'} ·{' '}
            {formatCelsius(extent.temperature.min)} to {formatCelsius(extent.temperature.max)} °C
            over {formatFixed(metresToMillimetres(extent.arc.max - extent.arc.min), 0)} mm
          </>
        ) : null
      }
      summary={
        extent
          ? `Temperature profile along the cut line across ${partOrder.size} parts, ${formatCelsius(extent.temperature.min)} to ${formatCelsius(extent.temperature.max)} °C.`
          : 'Temperature profile along the cut line. No data.'
      }
      bodyRef={bodyRef}
      empty={empty}
      className={className}
      height={height}
      overlay={
        geometry && !empty ? (
          <div
            className="hds-plot__legend hds-plot__legend--bottom-left"
            style={legendInset(geometry, 'bottom-left')}
          >
            {[...partOrder.entries()].map(([partId, index]) => (
              <span key={partId} className="hds-plot__legend-row">
                <span className="hds-plot__swatch" style={{ background: seriesColor(index) }} />
                {partNames?.[partId] ?? partId}
              </span>
            ))}
          </div>
        ) : null
      }
    >
      {geometry && !empty && (
        <PlotSurface geometry={geometry}>
          {spans?.map((span) => (
            <SpanShade key={span.id} geometry={geometry} span={span} />
          ))}
          <PlotAxes
            geometry={geometry}
            xTicks={xTicks}
            yTicks={yTicks}
            formatXTick={(value) => formatFixed(value, xDecimals)}
            formatYTick={(value) => formatFixed(value, yDecimals)}
            xLabel={xLabel}
            yLabel={yLabel}
          />
          {paths.map((path) => (
            <path
              key={path.key}
              d={path.d}
              fill="none"
              stroke={path.color}
              strokeWidth={1.8}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {threshold != null && (
            <ThresholdMarker
              geometry={geometry}
              value={threshold + ABSOLUTE_ZERO_C}
              orientation="horizontal"
              label={thresholdLabel ?? formatCelsiusWithUnit(threshold)}
            />
          )}
        </PlotSurface>
      )}
    </PlotFrame>
  );
}

const NO_POLYLINES =
  'The cut plane does not cross any part — move the section plane to see a profile.';
const NO_FINITE_POINTS = 'The cut line has no points with a temperature.';

interface ProfileExtent {
  /** metres */
  arc: Interval;
  /** kelvin */
  temperature: Interval;
}

function profileExtent(polylines: readonly SectionPolyline[]): ProfileExtent | null {
  let arc: Interval | null = null;
  let temperature: Interval | null = null;
  for (const line of polylines) {
    const lineArc = finiteExtent(line.arcLength);
    const lineTemperature = finiteExtent(line.temperature);
    if (!lineArc || !lineTemperature) continue;
    arc = arc
      ? { min: Math.min(arc.min, lineArc.min), max: Math.max(arc.max, lineArc.max) }
      : lineArc;
    temperature = temperature
      ? {
          min: Math.min(temperature.min, lineTemperature.min),
          max: Math.max(temperature.max, lineTemperature.max),
        }
      : lineTemperature;
  }
  return arc && temperature ? { arc, temperature } : null;
}

/** Two parallel arrays to the interleaved pairs `polylinePath` consumes. */
function interleave(x: ArrayLike<number>, y: ArrayLike<number>): Float64Array {
  const count = Math.min(x.length, y.length);
  const out = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    out[i * 2] = x[i];
    out[i * 2 + 1] = y[i];
  }
  return out;
}

interface SpanShadeProps {
  geometry: NonNullable<ReturnType<typeof computePlotGeometry>>;
  span: ProfileSpan;
}

function SpanShade({ geometry, span }: SpanShadeProps) {
  const { area } = geometry;
  const right = area.x + area.width;
  const from = geometry.px(metresToMillimetres(Math.min(span.from, span.to)));
  const to = geometry.px(metresToMillimetres(Math.max(span.from, span.to)));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;

  const left = Math.max(area.x, from);
  const edge = Math.min(right, to);
  if (edge <= left) return null;

  return (
    <g>
      <rect
        x={left}
        y={area.y}
        width={edge - left}
        height={area.height}
        fill={PLOT_COLORS.accent}
        opacity={0.1}
      />
      {span.label && (
        <text
          className="hds-plot__span-label"
          x={(left + edge) / 2}
          y={area.y + 13}
          textAnchor="middle"
        >
          {span.label}
        </text>
      )}
    </g>
  );
}
