/**
 * The chrome every plot shares: a captioned figure, a measured body, a canvas
 * layer for anything too dense for SVG, an SVG layer for axes and annotation, and
 * one explicit empty state.
 *
 * The graphic layers are `aria-hidden`; the caption plus a visually hidden summary
 * carry the same information to a screen reader, which is the only honest way to
 * expose a 100k-point scatter.
 */

import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { clamp, type PlotGeometry, scaleValue, type LinearScale, type PlotArea } from './scales';
import { PLOT_COLORS } from './theme';

/** Retina is worth it; a 3× phone screen is not, for a 100k-point cloud. */
const MAX_DEVICE_PIXEL_RATIO = 2;

export type PlotPainter = (
  context: CanvasRenderingContext2D,
  geometry: PlotGeometry,
  devicePixelRatio: number,
) => void;

export interface PlotFrameProps {
  title?: string;
  /** The headline figure, shown under the title. */
  note?: ReactNode;
  /** A sentence describing the data, for assistive technology. */
  summary?: string;
  /** Attach to the element that drives `useElementSize`. */
  bodyRef: RefObject<HTMLDivElement | null>;
  /** When set, replaces the body with this message. */
  empty?: string | null;
  /** Legends and colour ramps, positioned by their own class. */
  overlay?: ReactNode;
  className?: string;
  height?: number | string;
  children?: ReactNode;
}

export function PlotFrame({
  title,
  note,
  summary,
  bodyRef,
  empty,
  overlay,
  className,
  height = '100%',
  children,
}: PlotFrameProps) {
  return (
    <figure
      className={className ? `hds-plot ${className}` : 'hds-plot'}
      style={{ height: typeof height === 'number' ? `${height}px` : height }}
    >
      {(title || note) && (
        <figcaption className="hds-plot__head">
          {title && <span className="hds-plot__title">{title}</span>}
          {note && <span className="hds-plot__note">{note}</span>}
        </figcaption>
      )}
      {summary && <span className="hds-plot__sr">{summary}</span>}
      <div className="hds-plot__body" ref={bodyRef}>
        {empty ? <p className="hds-plot__empty">{empty}</p> : children}
        {!empty && overlay}
      </div>
    </figure>
  );
}

export interface PlotSurfaceProps {
  geometry: PlotGeometry;
  paint?: PlotPainter;
  /** SVG content, drawn over the canvas. */
  children?: ReactNode;
}

export function PlotSurface({ geometry, paint, children }: PlotSurfaceProps) {
  return (
    <>
      {paint && <PlotCanvas geometry={geometry} paint={paint} />}
      <svg
        className="hds-plot__svg"
        width={geometry.width}
        height={geometry.height}
        aria-hidden="true"
      >
        {children}
      </svg>
    </>
  );
}

interface PlotCanvasProps {
  geometry: PlotGeometry;
  paint: PlotPainter;
}

function PlotCanvas({ geometry, paint }: PlotCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
    canvas.width = Math.max(1, Math.round(geometry.width * ratio));
    canvas.height = Math.max(1, Math.round(geometry.height * ratio));
    canvas.style.width = `${geometry.width}px`;
    canvas.style.height = `${geometry.height}px`;

    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, geometry.width, geometry.height);
    paint(context, geometry, ratio);
  }, [geometry, paint]);

  return <canvas ref={canvasRef} className="hds-plot__canvas" aria-hidden="true" />;
}

export type PlotGrid = 'none' | 'x' | 'y' | 'both';

export interface PlotAxesProps {
  geometry: PlotGeometry;
  xTicks: readonly number[];
  yTicks: readonly number[];
  formatXTick: (value: number) => string;
  formatYTick: (value: number) => string;
  xLabel?: string;
  yLabel?: string;
  grid?: PlotGrid;
}

export function PlotAxes({
  geometry,
  xTicks,
  yTicks,
  formatXTick,
  formatYTick,
  xLabel,
  yLabel,
  grid = 'none',
}: PlotAxesProps) {
  const { area } = geometry;
  const bottom = area.y + area.height;
  const right = area.x + area.width;
  const showXGrid = grid === 'x' || grid === 'both';
  const showYGrid = grid === 'y' || grid === 'both';

  return (
    <g>
      {showYGrid &&
        yTicks.map((tick) => (
          <line
            key={`gy-${tick}`}
            x1={area.x}
            x2={right}
            y1={geometry.py(tick)}
            y2={geometry.py(tick)}
            stroke={PLOT_COLORS.grid}
          />
        ))}
      {showXGrid &&
        xTicks.map((tick) => (
          <line
            key={`gx-${tick}`}
            x1={geometry.px(tick)}
            x2={geometry.px(tick)}
            y1={area.y}
            y2={bottom}
            stroke={PLOT_COLORS.grid}
          />
        ))}

      <rect
        x={area.x}
        y={area.y}
        width={area.width}
        height={area.height}
        fill="none"
        stroke={PLOT_COLORS.axis}
      />

      {xTicks.map((tick) => (
        <g key={`x-${tick}`}>
          <line
            x1={geometry.px(tick)}
            x2={geometry.px(tick)}
            y1={bottom}
            y2={bottom + 4}
            stroke={PLOT_COLORS.axis}
          />
          <text
            className="hds-plot__tick"
            x={geometry.px(tick)}
            y={bottom + 15}
            textAnchor="middle"
          >
            {formatXTick(tick)}
          </text>
        </g>
      ))}

      {yTicks.map((tick) => (
        <g key={`y-${tick}`}>
          <line
            x1={area.x - 4}
            x2={area.x}
            y1={geometry.py(tick)}
            y2={geometry.py(tick)}
            stroke={PLOT_COLORS.axis}
          />
          <text
            className="hds-plot__tick"
            x={area.x - 7}
            y={geometry.py(tick)}
            textAnchor="end"
            dominantBaseline="middle"
          >
            {formatYTick(tick)}
          </text>
        </g>
      ))}

      {xLabel && (
        <text
          className="hds-plot__axis-label"
          x={area.x + area.width / 2}
          y={geometry.height - 4}
          textAnchor="middle"
        >
          {xLabel}
        </text>
      )}
      {yLabel && (
        <text
          className="hds-plot__axis-label"
          transform={`translate(11 ${area.y + area.height / 2}) rotate(-90)`}
          textAnchor="middle"
        >
          {yLabel}
        </text>
      )}
    </g>
  );
}

export interface ThresholdMarkerProps {
  geometry: PlotGeometry;
  /** Value in display units on the axis it crosses. */
  value: number;
  orientation: 'horizontal' | 'vertical';
  label?: string;
}

/** The user's limit line — dotted red, labelled inside the plot, as in the reference. */
export function ThresholdMarker({ geometry, value, orientation, label }: ThresholdMarkerProps) {
  const { area } = geometry;
  const right = area.x + area.width;
  const bottom = area.y + area.height;

  if (orientation === 'horizontal') {
    const y = geometry.py(value);
    if (!Number.isFinite(y) || y < area.y || y > bottom) return null;
    return (
      <g>
        <line
          x1={area.x}
          x2={right}
          y1={y}
          y2={y}
          stroke={PLOT_COLORS.threshold}
          strokeDasharray="2 3"
        />
        {label && (
          <text className="hds-plot__marker-label" x={right - 6} y={y - 5} textAnchor="end">
            {label}
          </text>
        )}
      </g>
    );
  }

  const x = geometry.px(value);
  if (!Number.isFinite(x) || x < area.x || x > right) return null;
  return (
    <g>
      <line
        x1={x}
        x2={x}
        y1={area.y}
        y2={bottom}
        stroke={PLOT_COLORS.threshold}
        strokeDasharray="2 3"
      />
      {label && (
        <text
          className="hds-plot__marker-label"
          transform={`translate(${x - 5} ${area.y + 6}) rotate(-90)`}
          textAnchor="end"
        >
          {label}
        </text>
      )}
    </g>
  );
}

export type LegendCorner = 'top-right' | 'bottom-left';

/**
 * Absolute offsets that pin a legend to a corner of the *data area* rather than of
 * the panel, so it cannot come to rest on top of the axis labels in the margins.
 */
export function legendInset(geometry: PlotGeometry, corner: LegendCorner): CSSProperties {
  const gap = 8;
  const { area } = geometry;
  if (corner === 'top-right') {
    return {
      top: area.y + gap,
      right: geometry.width - (area.x + area.width) + gap,
      maxWidth: Math.max(0, area.width - 2 * gap),
    };
  }
  return {
    top: 'auto',
    left: area.x + gap,
    bottom: geometry.height - (area.y + area.height) + gap,
    maxWidth: Math.max(0, area.width - 2 * gap),
  };
}

/** Builds an SVG path from interleaved (x, y) data pairs, skipping non-finite points. */
export function polylinePath(
  points: ArrayLike<number>,
  xScale: LinearScale,
  yScale: LinearScale,
  area?: PlotArea,
): string {
  let path = '';
  let penDown = false;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      penDown = false;
      continue;
    }
    let px = scaleValue(xScale, x);
    let py = scaleValue(yScale, y);
    if (area) {
      px = clamp(px, area.x, area.x + area.width);
      py = clamp(py, area.y, area.y + area.height);
    }
    path += `${penDown ? 'L' : 'M'}${px.toFixed(2)} ${py.toFixed(2)}`;
    penDown = true;
  }
  return path;
}
