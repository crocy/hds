/**
 * Temperature against conduction path length — spec §7.2, bottom-left of the
 * reference figure.
 *
 * Every node of the model is a point, so the cloud goes to canvas: 100k SVG
 * circles would not survive a resize. Axes, the fitted curve and the annotation
 * stay in SVG on top, where they render crisply and can be read from the DOM.
 */

import { useCallback, useMemo, useRef } from 'react';
import type { ColormapId, PathLengthResult } from '@/core/types';
import { ABSOLUTE_ZERO_C } from '@/core/units';
import {
  legendInset,
  PlotAxes,
  PlotFrame,
  PlotSurface,
  ThresholdMarker,
  polylinePath,
} from './PlotFrame';
import type { PlotPainter } from './PlotFrame';
import {
  formatCelsius,
  formatCelsiusWithUnit,
  formatDecayExpression,
  formatFixed,
  formatLambda,
  formatMillimetres,
  formatRSquared,
  metresToMillimetres,
} from './format';
import { createRgbaBuffer, fillRgbaBuffer, rasteriseScatter } from './raster';
import {
  computePlotGeometry,
  DEFAULT_PLOT_MARGINS,
  decimalsForTicks,
  type ExponentialDecay,
  finitePairExtent,
  generateTicks,
  includeInInterval,
  makeScale,
  niceInterval,
  placeCallout,
  sampleDecayCurve,
  scaleOverRawUnits,
} from './scales';
import { approximateTextWidth, PLOT_COLORS, PLOT_PANEL_RGB } from './theme';
import { useElementSize } from './useElementSize';
import './plots.css';

/** Low enough that the cloud shows density, high enough that a lone node is visible. */
const POINT_ALPHA = 0.55;
const CURVE_SAMPLES = 160;
const CALLOUT_FONT_SIZE = 10.5;

export interface PathLengthAnnotation {
  /** Index into `result.distance` and `temperature`. */
  nodeIndex: number;
  label: string;
  /** Second line. Defaults to `61 mm of metal → 77 °C`. */
  detail?: string;
}

export interface ReferenceDecay extends ExponentialDecay {
  label: string;
}

export interface PathLengthPlotProps {
  result: PathLengthResult | null;
  /** Node temperatures in kelvin, index-aligned with `result.distance`. */
  temperature: ArrayLike<number> | null;
  colorMap?: ColormapId;
  /** kelvin. Colour range for the points; defaults to the temperature extent. */
  colorRange?: readonly [number, number] | null;
  /** kelvin. Draws a horizontal limit line. */
  threshold?: number | null;
  thresholdLabel?: string;
  annotation?: PathLengthAnnotation | null;
  /** A curve to judge the fit against — the reference's "bare fin, no insulation". */
  referenceDecay?: ReferenceDecay | null;
  title?: string;
  xLabel?: string;
  yLabel?: string;
  height?: number | string;
  className?: string;
}

export function PathLengthPlot({
  result,
  temperature,
  colorMap = 'inferno',
  colorRange,
  threshold,
  thresholdLabel,
  annotation,
  referenceDecay,
  title = 'every node of the model, by metal path length',
  xLabel = 'shortest conduction path from the source  [mm]',
  yLabel = 'temperature  [°C]',
  height,
  className,
}: PathLengthPlotProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(bodyRef);

  const extent = useMemo(
    () => (result && temperature ? finitePairExtent(result.distance, temperature) : null),
    [result, temperature],
  );

  const fit = result?.fit ?? null;

  const xDomain = useMemo(() => {
    if (!extent) return { min: 0, max: 1 };
    return niceInterval(
      Math.min(0, metresToMillimetres(extent.x.min)),
      metresToMillimetres(extent.x.max),
      6,
    );
  }, [extent]);

  const yDomain = useMemo(() => {
    if (!extent) return { min: 0, max: 1 };
    let span = {
      min: extent.y.min + ABSOLUTE_ZERO_C,
      max: extent.y.max + ABSOLUTE_ZERO_C,
    };
    // The limit line and the fit's asymptote are part of the story even when no
    // node sits near them; an axis that crops them off hides the conclusion.
    if (threshold != null) span = includeInInterval(span, threshold + ABSOLUTE_ZERO_C);
    if (fit) span = includeInInterval(span, fit.tInfinity + ABSOLUTE_ZERO_C);
    return niceInterval(span.min, span.max, 6);
  }, [extent, threshold, fit]);

  const geometry = useMemo(
    () => computePlotGeometry(size.width, size.height, DEFAULT_PLOT_MARGINS, xDomain, yDomain),
    [size.width, size.height, xDomain, yDomain],
  );

  const colorMin = colorRange ? colorRange[0] : (extent?.y.min ?? 0);
  const colorMax = colorRange ? colorRange[1] : (extent?.y.max ?? 1);

  const distances = result?.distance ?? null;
  const paint = useCallback<PlotPainter>(
    (context, plot, ratio) => {
      if (!distances || !temperature) return;
      const bufferWidth = Math.max(1, Math.round(plot.area.width * ratio));
      const bufferHeight = Math.max(1, Math.round(plot.area.height * ratio));
      const buffer = createRgbaBuffer(bufferWidth, bufferHeight);
      // The scatter *is* the evidence, so it gets the panel to itself rather than
      // the blurred 3D view the dock is translucent over.
      fillRgbaBuffer(buffer, PLOT_PANEL_RGB);

      // Scales over the raw arrays: metres and kelvin in, buffer pixels out, so
      // 100k values need no converted copy.
      const xPixels = scaleOverRawUnits(makeScale(xDomain, 0, bufferWidth), 1000, 0);
      const yPixels = scaleOverRawUnits(makeScale(yDomain, bufferHeight, 0), 1, ABSOLUTE_ZERO_C);

      rasteriseScatter(buffer, distances, temperature, temperature, xPixels, yPixels, {
        map: colorMap,
        min: colorMin,
        max: colorMax,
        alpha: POINT_ALPHA,
        radius: stampRadius(ratio),
      });

      // putImageData ignores the canvas transform, so the offset is in device pixels.
      context.putImageData(
        new ImageData(buffer.data, bufferWidth, bufferHeight),
        Math.round(plot.area.x * ratio),
        Math.round(plot.area.y * ratio),
      );
    },
    [distances, temperature, xDomain, yDomain, colorMap, colorMin, colorMax],
  );

  const empty = !result || !temperature ? NO_SOLVE : !extent ? NO_REACHABLE_NODES : null;

  const xTicks = geometry ? generateTicks(xDomain.min, xDomain.max, 6) : [];
  const yTicks = geometry ? generateTicks(yDomain.min, yDomain.max, 6) : [];
  const xDecimals = decimalsForTicks(xTicks);
  const yDecimals = decimalsForTicks(yTicks);

  const maxDistance = extent?.x.max ?? 0;
  const fitPath =
    geometry && fit
      ? polylinePath(
          sampleDecayCurve(fit, 0, maxDistance, CURVE_SAMPLES),
          scaleOverRawUnits(geometry.x, 1000, 0),
          scaleOverRawUnits(geometry.y, 1, ABSOLUTE_ZERO_C),
          geometry.area,
        )
      : '';
  const referencePath =
    geometry && referenceDecay
      ? polylinePath(
          sampleDecayCurve(referenceDecay, 0, maxDistance, CURVE_SAMPLES),
          scaleOverRawUnits(geometry.x, 1000, 0),
          scaleOverRawUnits(geometry.y, 1, ABSOLUTE_ZERO_C),
          geometry.area,
        )
      : '';

  const marked = resolveAnnotation(annotation, result, temperature);

  return (
    <PlotFrame
      title={title}
      note={
        extent ? (
          <>
            <strong>{extent.count.toLocaleString()}</strong> nodes
            {fit ? (
              <>
                {' · '}
                <strong>{formatLambda(fit.lambda)}</strong>
                {` · ${formatRSquared(fit.rSquared)}`}
              </>
            ) : (
              ' · no exponential fit'
            )}
          </>
        ) : null
      }
      summary={buildSummary(extent, fit)}
      bodyRef={bodyRef}
      empty={empty}
      className={className}
      height={height}
      overlay={
        geometry && !empty && (fit || referenceDecay) ? (
          <div className="hds-plot__legend" style={legendInset(geometry, 'top-right')}>
            {fit && (
              <span className="hds-plot__legend-row" style={{ color: PLOT_COLORS.accent }}>
                <span className="hds-plot__swatch" style={{ background: PLOT_COLORS.accent }} />
                fit: {formatDecayExpression(fit)}
              </span>
            )}
            {referenceDecay && (
              <span className="hds-plot__legend-row" style={{ color: PLOT_COLORS.reference }}>
                <span
                  className="hds-plot__swatch hds-plot__swatch--dashed"
                  style={{ color: PLOT_COLORS.reference }}
                />
                {referenceDecay.label}
              </span>
            )}
          </div>
        ) : null
      }
    >
      {geometry && !empty && (
        <PlotSurface geometry={geometry} paint={paint}>
          <PlotAxes
            geometry={geometry}
            xTicks={xTicks}
            yTicks={yTicks}
            formatXTick={(value) => formatFixed(value, xDecimals)}
            formatYTick={(value) => formatFixed(value, yDecimals)}
            xLabel={xLabel}
            yLabel={yLabel}
          />
          {referencePath && (
            <path
              d={referencePath}
              fill="none"
              stroke={PLOT_COLORS.reference}
              strokeWidth={1.6}
              strokeDasharray="5 4"
            />
          )}
          {fitPath && (
            <path d={fitPath} fill="none" stroke={PLOT_COLORS.accent} strokeWidth={1.9} />
          )}
          {threshold != null && (
            <ThresholdMarker
              geometry={geometry}
              value={threshold + ABSOLUTE_ZERO_C}
              orientation="horizontal"
              label={thresholdLabel ?? formatCelsiusWithUnit(threshold)}
            />
          )}
          {marked && <AnnotationCallout geometry={geometry} marked={marked} />}
        </PlotSurface>
      )}
    </PlotFrame>
  );
}

/**
 * Half-size of a point in buffer pixels, chosen so a node covers about three CSS
 * pixels whatever the display's density — a single device pixel is invisible on the
 * dark panel, and a cloud of 5k nodes is far sparser than the 100k this can take.
 */
function stampRadius(devicePixelRatio: number): number {
  return Math.max(1, Math.round(devicePixelRatio));
}

const NO_SOLVE = 'No solve yet — run a solve to plot temperature against conduction path length.';
const NO_REACHABLE_NODES =
  'No node has both a finite path length and a temperature. Check that a fixed-temperature boundary exists and that the parts are connected.';

interface MarkedNode {
  /** metres */
  distance: number;
  /** kelvin */
  temperature: number;
  label: string;
  detail: string;
}

function resolveAnnotation(
  annotation: PathLengthAnnotation | null | undefined,
  result: PathLengthResult | null,
  temperature: ArrayLike<number> | null,
): MarkedNode | null {
  if (!annotation || !result || !temperature) return null;
  const index = annotation.nodeIndex;
  if (!Number.isInteger(index) || index < 0 || index >= result.distance.length) return null;
  const distance = result.distance[index];
  const value = temperature[index];
  if (!Number.isFinite(distance) || !Number.isFinite(value)) return null;
  return {
    distance,
    temperature: value,
    label: annotation.label,
    detail:
      annotation.detail ??
      `${formatMillimetres(distance)} mm of metal → ${formatCelsius(value)} °C`,
  };
}

function buildSummary(
  extent: ReturnType<typeof finitePairExtent>,
  fit: PathLengthResult['fit'],
): string {
  if (!extent) return 'Temperature against conduction path length. No data.';
  const range = `${formatCelsius(extent.y.min)} to ${formatCelsius(extent.y.max)} °C over 0 to ${formatMillimetres(extent.x.max)} mm`;
  const fitText = fit
    ? ` Exponential fit ${formatLambda(fit.lambda)}, ${formatRSquared(fit.rSquared)}.`
    : ' No exponential fit converged.';
  return `Scatter of ${extent.count} nodes, ${range}.${fitText}`;
}

interface AnnotationCalloutProps {
  geometry: NonNullable<ReturnType<typeof computePlotGeometry>>;
  marked: MarkedNode;
}

function AnnotationCallout({ geometry, marked }: AnnotationCalloutProps) {
  const pointX = geometry.px(metresToMillimetres(marked.distance));
  const pointY = geometry.py(marked.temperature + ABSOLUTE_ZERO_C);
  if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) return null;

  const textWidth = Math.max(
    approximateTextWidth(marked.label, CALLOUT_FONT_SIZE),
    approximateTextWidth(marked.detail, CALLOUT_FONT_SIZE),
  );
  const lineHeight = CALLOUT_FONT_SIZE * 1.35;
  const placement = placeCallout(pointX, pointY, geometry.area, textWidth, lineHeight * 2);

  return (
    <g>
      <line
        x1={pointX}
        y1={pointY}
        x2={placement.leaderX}
        y2={placement.leaderY}
        stroke={PLOT_COLORS.accent}
        strokeWidth={1.2}
      />
      <circle
        cx={pointX}
        cy={pointY}
        r={5}
        fill="none"
        stroke={PLOT_COLORS.accent}
        strokeWidth={1.6}
      />
      {/* A halo behind the text, so the callout stays legible over the dense cloud. */}
      <text
        className="hds-plot__callout hds-plot__callout--halo"
        x={placement.x}
        y={placement.y + lineHeight * 0.8}
      >
        {marked.label}
      </text>
      <text className="hds-plot__callout" x={placement.x} y={placement.y + lineHeight * 0.8}>
        {marked.label}
      </text>
      <text
        className="hds-plot__callout hds-plot__callout--halo"
        x={placement.x}
        y={placement.y + lineHeight * 1.8}
      >
        {marked.detail}
      </text>
      <text className="hds-plot__callout" x={placement.x} y={placement.y + lineHeight * 1.8}>
        {marked.detail}
      </text>
    </g>
  );
}
