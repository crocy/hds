/**
 * The filled temperature field on the cut plane — spec §7.1, bottom-middle of the
 * reference figure.
 *
 * The grid goes to canvas as an ImageData scaled up with smoothing off, so the
 * cells stay visibly discrete: this field is an approximation that ignores
 * out-of-plane flux, and smoothing it into a continuous wash would oversell it.
 * Contours are drawn as white strokes over the fill, axes in SVG.
 */

import { useCallback, useMemo, useRef } from 'react';
import type { ColormapId, SectionField2D } from '@/core/types';
import { gradientCss } from '@/viewer/colormap';
import { PlotAxes, PlotFrame, PlotSurface } from './PlotFrame';
import type { PlotPainter } from './PlotFrame';
import { formatCelsius, formatFixed, metresToMillimetres } from './format';
import { rasteriseField } from './raster';
import {
  computePlotGeometry,
  DEFAULT_PLOT_MARGINS,
  decimalsForTicks,
  finiteExtent,
  generateTicks,
  niceInterval,
  scaleOverRawUnits,
  scaleValue,
} from './scales';
import { PLOT_COLORS } from './theme';
import { useElementSize } from './useElementSize';
import './plots.css';

/** The ramp needs room the axis does not. */
const FIELD_MARGINS = { ...DEFAULT_PLOT_MARGINS, right: 54 };
const CONTOUR_WIDTH = 1;

export interface SectionFieldPlotProps {
  field: SectionField2D | null;
  colorMap?: ColormapId;
  /** kelvin. Defaults to the field's own finite range. */
  range?: readonly [number, number] | null;
  showContours?: boolean;
  showLegend?: boolean;
  title?: string;
  /** Axis captions; the plane's in-plane axes are named by the caller. */
  uLabel?: string;
  vLabel?: string;
  height?: number | string;
  className?: string;
}

export function SectionFieldPlot({
  field,
  colorMap = 'inferno',
  range,
  showContours = true,
  showLegend = true,
  title = 'inside the model, on the cut plane',
  uLabel = 'U  [mm]',
  vLabel = 'V  [mm]',
  height,
  className,
}: SectionFieldPlotProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(bodyRef);

  const dataRange = useMemo(() => (field ? finiteExtent(field.values) : null), [field]);
  const rangeMin = range ? range[0] : (dataRange?.min ?? 0);
  const rangeMax = range ? range[1] : (dataRange?.max ?? 1);

  const uDomain = useMemo(
    () =>
      field
        ? niceInterval(metresToMillimetres(field.uMin), metresToMillimetres(field.uMax), 6)
        : { min: 0, max: 1 },
    [field],
  );
  const vDomain = useMemo(
    () =>
      field
        ? niceInterval(metresToMillimetres(field.vMin), metresToMillimetres(field.vMax), 6)
        : { min: 0, max: 1 },
    [field],
  );

  const geometry = useMemo(
    () =>
      computePlotGeometry(size.width, size.height, FIELD_MARGINS, uDomain, vDomain, {
        equalAxisScale: true,
      }),
    [size.width, size.height, uDomain, vDomain],
  );

  const paint = useCallback<PlotPainter>(
    (context, plot) => {
      if (!field || field.width < 1 || field.height < 1) return;

      const buffer = rasteriseField(field, { map: colorMap, min: rangeMin, max: rangeMax });
      const tile = document.createElement('canvas');
      tile.width = buffer.width;
      tile.height = buffer.height;
      const tileContext = tile.getContext('2d');
      if (!tileContext) return;
      tileContext.putImageData(new ImageData(buffer.data, buffer.width, buffer.height), 0, 0);

      // The grid's extent, not the axis domain: the axis is rounded outward to
      // whole millimetres, so the image must be placed where its data actually is.
      const uPixels = scaleOverRawUnits(plot.x, 1000, 0);
      const vPixels = scaleOverRawUnits(plot.y, 1000, 0);
      const left = scaleValue(uPixels, field.uMin);
      const rightEdge = scaleValue(uPixels, field.uMax);
      const bottom = scaleValue(vPixels, field.vMin);
      const top = scaleValue(vPixels, field.vMax);

      context.save();
      context.beginPath();
      context.rect(plot.area.x, plot.area.y, plot.area.width, plot.area.height);
      context.clip();
      context.imageSmoothingEnabled = false;
      context.drawImage(tile, left, top, rightEdge - left, bottom - top);

      if (showContours) {
        context.strokeStyle = PLOT_COLORS.contour;
        context.lineWidth = CONTOUR_WIDTH;
        context.beginPath();
        for (const contour of field.contours) {
          const segments = contour.segments;
          for (let i = 0; i + 3 < segments.length; i += 4) {
            context.moveTo(scaleValue(uPixels, segments[i]), scaleValue(vPixels, segments[i + 1]));
            context.lineTo(
              scaleValue(uPixels, segments[i + 2]),
              scaleValue(vPixels, segments[i + 3]),
            );
          }
        }
        context.stroke();
      }
      context.restore();
    },
    [field, colorMap, rangeMin, rangeMax, showContours],
  );

  const empty = !field
    ? NO_FIELD
    : field.width < 1 || field.height < 1
      ? EMPTY_GRID
      : !dataRange
        ? NO_FINITE_CELLS
        : null;

  const uTicks = geometry ? generateTicks(uDomain.min, uDomain.max, 6) : [];
  const vTicks = geometry ? generateTicks(vDomain.min, vDomain.max, 6) : [];
  const uDecimals = decimalsForTicks(uTicks);
  const vDecimals = decimalsForTicks(vTicks);

  const contourLevels = field?.contours.map((contour) => contour.level) ?? [];

  return (
    <PlotFrame
      title={title}
      note={
        dataRange ? (
          <>
            <strong>
              {formatCelsius(rangeMin)} to {formatCelsius(rangeMax)} °C
            </strong>
            {contourLevels.length > 0 &&
              ` · contours at ${contourLevels.map((level) => formatCelsius(level)).join(', ')} °C`}
          </>
        ) : null
      }
      summary={
        dataRange
          ? `Filled temperature field on the cut plane, ${formatCelsius(dataRange.min)} to ${formatCelsius(dataRange.max)} °C.`
          : 'Filled temperature field on the cut plane. No data.'
      }
      bodyRef={bodyRef}
      empty={empty}
      className={className}
      height={height}
      overlay={
        geometry && !empty && showLegend ? (
          <div
            className="hds-plot__ramp"
            style={{
              top: geometry.area.y,
              bottom: geometry.height - (geometry.area.y + geometry.area.height),
            }}
          >
            <div className="hds-plot__ramp-scale">
              <span>{formatCelsius(rangeMax)}</span>
              <span>{formatCelsius((rangeMin + rangeMax) / 2)}</span>
              <span>{formatCelsius(rangeMin)}</span>
            </div>
            <div
              className="hds-plot__ramp-bar"
              style={{ background: gradientCss(colorMap, 24, '0deg') }}
            />
          </div>
        ) : null
      }
    >
      {geometry && !empty && (
        <PlotSurface geometry={geometry} paint={paint}>
          <PlotAxes
            geometry={geometry}
            xTicks={uTicks}
            yTicks={vTicks}
            formatXTick={(value) => formatFixed(value, uDecimals)}
            formatYTick={(value) => formatFixed(value, vDecimals)}
            xLabel={uLabel}
            yLabel={vLabel}
          />
        </PlotSurface>
      )}
    </PlotFrame>
  );
}

const NO_FIELD = 'No cut plane yet — position the section plane and solve to see the 2D field.';
const EMPTY_GRID = 'The cut plane does not intersect the model.';
const NO_FINITE_CELLS =
  'Every cell on this plane is outside the model. Move the plane so it crosses a part.';
