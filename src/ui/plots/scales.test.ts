import { describe, expect, it } from 'vitest';
import {
  clamp,
  computePlotGeometry,
  DEFAULT_PLOT_MARGINS,
  decimalsForStep,
  decimalsForTicks,
  evaluateDecay,
  finiteExtent,
  finitePairExtent,
  fitAreaToAspect,
  generateTicks,
  includeInInterval,
  makeScale,
  niceInterval,
  niceStep,
  placeCallout,
  residualSeverity,
  sampleDecayCurve,
  scaleOverRawUnits,
  scaleValue,
  stackSegments,
} from './scales';

describe('niceStep', () => {
  it('snaps to the nearest of 1, 2, 2.5 or 5 times a power of ten', () => {
    expect(niceStep(1)).toBe(1);
    expect(niceStep(1.5)).toBe(2);
    expect(niceStep(2.1)).toBe(2);
    expect(niceStep(3)).toBe(2.5);
    expect(niceStep(7)).toBe(5);
    expect(niceStep(8)).toBe(10);
    expect(niceStep(23)).toBe(25);
    expect(niceStep(0.03)).toBeCloseTo(0.025, 12);
  });

  it('never returns a step so fine that the axis crowds', () => {
    for (const span of [1, 3, 7, 18, 180, 4321, 0.006]) {
      const count = span / niceStep(span / 6);
      expect(count).toBeLessThanOrEqual(6 * 1.5 + 1);
      expect(count).toBeGreaterThanOrEqual(3);
    }
  });

  it('falls back to 1 for a non-positive or non-finite step', () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(-4)).toBe(1);
    expect(niceStep(NaN)).toBe(1);
    expect(niceStep(Infinity)).toBe(1);
  });
});

describe('generateTicks', () => {
  it('produces round numbers inside the domain', () => {
    expect(generateTicks(0, 300, 6)).toEqual([0, 50, 100, 150, 200, 250, 300]);
    expect(generateTicks(20, 200, 6)).toEqual([25, 50, 75, 100, 125, 150, 175, 200]);
  });

  it('does not emit float noise', () => {
    for (const tick of generateTicks(0, 1, 10)) {
      expect(Number(tick.toFixed(10))).toBe(tick);
    }
    expect(generateTicks(0, 1, 10)).toContain(0.3);
  });

  it('handles a reversed domain', () => {
    expect(generateTicks(300, 0, 6)).toEqual(generateTicks(0, 300, 6));
  });

  it('degrades gracefully instead of hanging or emitting NaN', () => {
    expect(generateTicks(5, 5)).toEqual([5]);
    expect(generateTicks(NaN, 10)).toEqual([]);
    expect(generateTicks(0, Infinity)).toEqual([]);
    expect(generateTicks(-Infinity, Infinity)).toEqual([]);
  });

  it('caps the tick count so a pathological domain cannot lock the render', () => {
    expect(generateTicks(0, 1e12, 2).length).toBeLessThanOrEqual(200);
  });
});

describe('decimalsForStep / decimalsForTicks', () => {
  it('gives enough places to distinguish neighbouring ticks', () => {
    expect(decimalsForStep(1)).toBe(0);
    expect(decimalsForStep(25)).toBe(0);
    expect(decimalsForStep(0.5)).toBe(1);
    expect(decimalsForStep(0.05)).toBe(2);
    expect(decimalsForStep(2.5)).toBe(1);
    expect(decimalsForStep(0.25)).toBe(2);
  });

  it('is zero for a degenerate step', () => {
    expect(decimalsForStep(0)).toBe(0);
    expect(decimalsForStep(NaN)).toBe(0);
  });

  it('reads the decimals off the tightest gap', () => {
    expect(decimalsForTicks([0, 25, 50])).toBe(0);
    expect(decimalsForTicks([0, 0.25, 0.5])).toBe(2);
    expect(decimalsForTicks([])).toBe(0);
    expect(decimalsForTicks([7])).toBe(0);
  });
});

describe('niceInterval', () => {
  it('expands outward to round bounds', () => {
    expect(niceInterval(3, 287, 6)).toEqual({ min: 0, max: 300 });
    expect(niceInterval(21.4, 199.6, 6)).toEqual({ min: 0, max: 200 });
  });

  it('gives a zero-width interval a usable width', () => {
    expect(niceInterval(5, 5)).toEqual({ min: 4.5, max: 5.5 });
  });

  it('falls back to the unit interval when the input is not finite', () => {
    expect(niceInterval(NaN, 4)).toEqual({ min: 0, max: 1 });
  });
});

describe('includeInInterval', () => {
  it('grows to include a value, and ignores a non-finite one', () => {
    expect(includeInInterval({ min: 0, max: 10 }, 12)).toEqual({ min: 0, max: 12 });
    expect(includeInInterval({ min: 0, max: 10 }, -3)).toEqual({ min: -3, max: 10 });
    expect(includeInInterval({ min: 0, max: 10 }, NaN)).toEqual({ min: 0, max: 10 });
  });
});

describe('finiteExtent', () => {
  it('ignores NaN and Infinity', () => {
    expect(finiteExtent([3, NaN, 1, Infinity, 7])).toEqual({ min: 1, max: 7 });
  });

  it('is null when nothing is finite', () => {
    expect(finiteExtent([])).toBeNull();
    expect(finiteExtent([NaN, Infinity, -Infinity])).toBeNull();
  });
});

describe('finitePairExtent', () => {
  it('drops points where either coordinate is not finite', () => {
    const distance = [0, Infinity, 0.05, 0.1];
    const temperature = [473, 300, NaN, 320];
    expect(finitePairExtent(distance, temperature)).toEqual({
      x: { min: 0, max: 0.1 },
      y: { min: 320, max: 473 },
      count: 2,
    });
  });

  it('is null when every node is unreachable', () => {
    expect(finitePairExtent([Infinity, Infinity], [300, 310])).toBeNull();
  });

  it('stops at the shorter of the two arrays', () => {
    expect(finitePairExtent([0, 1, 2], [300])?.count).toBe(1);
  });
});

describe('scales', () => {
  const scale = makeScale({ min: 0, max: 100 }, 10, 210);

  it('maps the domain onto the range', () => {
    expect(scaleValue(scale, 0)).toBe(10);
    expect(scaleValue(scale, 100)).toBe(210);
    expect(scaleValue(scale, 50)).toBe(110);
  });

  it('extrapolates outside the domain rather than clamping', () => {
    expect(scaleValue(scale, 150)).toBe(310);
  });

  it('sends a zero-width domain to the middle of the range instead of NaN', () => {
    const flat = makeScale({ min: 7, max: 7 }, 0, 100);
    expect(scaleValue(flat, 7)).toBe(50);
    expect(scaleValue(flat, 9)).toBe(50);
  });

  it('supports an inverted range, as a y axis needs', () => {
    const y = makeScale({ min: 0, max: 100 }, 200, 0);
    expect(scaleValue(y, 0)).toBe(200);
    expect(scaleValue(y, 100)).toBe(0);
  });
});

describe('scaleOverRawUnits', () => {
  it('lets a mm axis be driven by metre values', () => {
    const display = makeScale({ min: 0, max: 300 }, 0, 600);
    const raw = scaleOverRawUnits(display, 1000, 0);
    expect(scaleValue(raw, 0.15)).toBeCloseTo(scaleValue(display, 150), 9);
    expect(raw.domainMax).toBeCloseTo(0.3, 12);
  });

  it('lets a °C axis be driven by kelvin values', () => {
    const display = makeScale({ min: 20, max: 200 }, 400, 0);
    const raw = scaleOverRawUnits(display, 1, -273.15);
    expect(scaleValue(raw, 293.15)).toBeCloseTo(400, 9);
    expect(scaleValue(raw, 473.15)).toBeCloseTo(0, 9);
  });

  it('is a no-op for a degenerate conversion', () => {
    const display = makeScale({ min: 0, max: 1 }, 0, 1);
    expect(scaleOverRawUnits(display, 0, 0)).toBe(display);
  });
});

describe('computePlotGeometry', () => {
  it('places the data area inside the margins', () => {
    const geometry = computePlotGeometry(
      400,
      300,
      DEFAULT_PLOT_MARGINS,
      { min: 0, max: 10 },
      { min: 0, max: 100 },
    );
    expect(geometry).not.toBeNull();
    expect(geometry?.area).toEqual({
      x: DEFAULT_PLOT_MARGINS.left,
      y: DEFAULT_PLOT_MARGINS.top,
      width: 400 - DEFAULT_PLOT_MARGINS.left - DEFAULT_PLOT_MARGINS.right,
      height: 300 - DEFAULT_PLOT_MARGINS.top - DEFAULT_PLOT_MARGINS.bottom,
    });
  });

  it('puts y = max at the top of the area', () => {
    const geometry = computePlotGeometry(
      400,
      300,
      DEFAULT_PLOT_MARGINS,
      { min: 0, max: 10 },
      { min: 0, max: 100 },
    );
    expect(geometry?.py(100)).toBe(DEFAULT_PLOT_MARGINS.top);
    expect(geometry?.py(0)).toBe(300 - DEFAULT_PLOT_MARGINS.bottom);
    expect(geometry?.px(0)).toBe(DEFAULT_PLOT_MARGINS.left);
  });

  it('is null before the container has been measured', () => {
    const domain = { min: 0, max: 1 };
    expect(computePlotGeometry(0, 0, DEFAULT_PLOT_MARGINS, domain, domain)).toBeNull();
    expect(computePlotGeometry(20, 20, DEFAULT_PLOT_MARGINS, domain, domain)).toBeNull();
  });
});

describe('clamp', () => {
  it('bounds a value', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe('exponential decay', () => {
  const fit = { lambda: 0.046, tInfinity: 308.15, deltaT: 160 };

  it('evaluates T = Tinf + dT exp(-s/lambda)', () => {
    expect(evaluateDecay(fit, 0)).toBeCloseTo(468.15, 9);
    expect(evaluateDecay(fit, fit.lambda)).toBeCloseTo(308.15 + 160 / Math.E, 9);
    expect(evaluateDecay(fit, 10)).toBeCloseTo(308.15, 6);
  });

  it('samples the curve as interleaved (s, T) pairs spanning the range', () => {
    const curve = sampleDecayCurve(fit, 0, 0.3, 4);
    expect(curve.length).toBe(8);
    expect(curve[0]).toBe(0);
    expect(curve[6]).toBeCloseTo(0.3, 12);
    expect(curve[1]).toBeCloseTo(468.15, 9);
    expect(curve[1]).toBeGreaterThan(curve[7]);
  });

  it('draws nothing for a fit that failed', () => {
    expect(sampleDecayCurve({ ...fit, lambda: 0 }, 0, 1).length).toBe(0);
    expect(sampleDecayCurve({ ...fit, lambda: -0.1 }, 0, 1).length).toBe(0);
    expect(sampleDecayCurve({ ...fit, lambda: NaN }, 0, 1).length).toBe(0);
    expect(sampleDecayCurve(fit, 0, 0).length).toBe(0);
    expect(sampleDecayCurve(fit, 1, 0).length).toBe(0);
  });
});

describe('stackSegments', () => {
  it('splits a bar by share of total magnitude', () => {
    const segments = stackSegments([30, 10]);
    expect(segments[0].start).toBe(0);
    expect(segments[0].end).toBeCloseTo(0.75, 12);
    expect(segments[1].end).toBeCloseTo(1, 12);
  });

  it('gives a negative contribution a visible width', () => {
    const segments = stackSegments([-30, 10]);
    expect(segments[0].end).toBeCloseTo(0.75, 12);
    expect(segments[0].value).toBe(-30);
  });

  it('collapses to zero width when nothing flows', () => {
    expect(stackSegments([0, 0])).toEqual([
      { value: 0, start: 0, end: 0 },
      { value: 0, start: 0, end: 0 },
    ]);
    expect(stackSegments([NaN])).toEqual([{ value: NaN, start: 0, end: 0 }]);
  });
});

describe('residualSeverity', () => {
  it('is quiet for a residual that is float noise on the throughput', () => {
    expect(residualSeverity(0, 61)).toBe('ok');
    expect(residualSeverity(0.1, 61)).toBe('ok');
  });

  it('escalates as the imbalance grows', () => {
    expect(residualSeverity(0.61, 61)).toBe('warn');
    expect(residualSeverity(6.1, 61)).toBe('bad');
    expect(residualSeverity(-6.1, 61)).toBe('bad');
  });

  it('is bad when there is no throughput to measure against but a residual exists', () => {
    expect(residualSeverity(1, 0)).toBe('bad');
    expect(residualSeverity(0, 0)).toBe('ok');
  });

  it('is bad for a non-finite residual', () => {
    expect(residualSeverity(NaN, 61)).toBe('bad');
    expect(residualSeverity(Infinity, 61)).toBe('bad');
  });
});

describe('fitAreaToAspect', () => {
  const area = { x: 10, y: 10, width: 400, height: 200 };

  it('gives both axes the same pixels-per-unit', () => {
    const fitted = fitAreaToAspect(area, 100, 100);
    expect(fitted.width).toBe(200);
    expect(fitted.height).toBe(200);
    expect(fitted.width / 100).toBeCloseTo(fitted.height / 100, 12);
  });

  it('centres the letterboxed area inside the original', () => {
    const fitted = fitAreaToAspect(area, 100, 100);
    expect(fitted.x).toBe(10 + (400 - 200) / 2);
    expect(fitted.y).toBe(10);
  });

  it('leaves a degenerate span alone rather than collapsing the plot', () => {
    expect(fitAreaToAspect(area, 0, 100)).toBe(area);
    expect(fitAreaToAspect(area, 100, NaN)).toBe(area);
  });
});

describe('computePlotGeometry with equalAxisScale', () => {
  it('keeps a cut plane undistorted in a panel of the wrong shape', () => {
    const geometry = computePlotGeometry(
      600,
      600,
      { top: 0, right: 0, bottom: 0, left: 0 },
      { min: -100, max: 100 },
      { min: 0, max: 100 },
      { equalAxisScale: true },
    );
    const pixelsPerUnitX = (geometry!.px(100) - geometry!.px(-100)) / 200;
    const pixelsPerUnitY = (geometry!.py(0) - geometry!.py(100)) / 100;
    expect(pixelsPerUnitX).toBeCloseTo(pixelsPerUnitY, 9);
  });
});

describe('placeCallout', () => {
  const area = { x: 0, y: 0, width: 400, height: 300 };

  it('offsets up and to the right when there is room', () => {
    const placement = placeCallout(100, 200, area, 120, 24);
    expect(placement.x).toBeGreaterThan(100);
    expect(placement.y).toBeLessThan(200);
  });

  it('mirrors to the left rather than overflowing the right edge', () => {
    const placement = placeCallout(380, 200, area, 120, 24);
    expect(placement.x + placement.width).toBeLessThanOrEqual(area.x + area.width);
  });

  it('keeps the block inside the plot area on every edge', () => {
    for (const [x, y] of [
      [0, 0],
      [400, 300],
      [0, 300],
      [400, 0],
      [200, 150],
    ]) {
      const placement = placeCallout(x, y, area, 180, 24);
      expect(placement.x).toBeGreaterThanOrEqual(area.x);
      expect(placement.x + placement.width).toBeLessThanOrEqual(area.x + area.width + 1e-9);
      expect(placement.y).toBeGreaterThanOrEqual(area.y);
      expect(placement.y + placement.height).toBeLessThanOrEqual(area.y + area.height + 1e-9);
    }
  });

  it('never lets the block be wider than the area it must fit in', () => {
    const placement = placeCallout(200, 150, area, 900, 24);
    expect(placement.width).toBe(area.width);
  });

  it('attaches the leader to the block edge facing the point, never the far side', () => {
    // A block clamped past its own point must still point back at it.
    const placement = placeCallout(390, 150, area, 380, 24);
    expect(placement.leaderX).toBeGreaterThanOrEqual(placement.x);
    expect(placement.leaderX).toBeLessThanOrEqual(placement.x + placement.width);
    expect(placement.leaderY).toBeGreaterThanOrEqual(placement.y);
    expect(placement.leaderY).toBeLessThanOrEqual(placement.y + placement.height);
  });

  it('meets the near edge of the block, not its far side', () => {
    const placement = placeCallout(200, 150, area, 100, 24);
    // The block sits up and to the right, so the leader lands on its left edge.
    expect(placement.leaderX).toBeCloseTo(placement.x, 9);
    expect(placement.leaderY).toBeCloseTo(placement.y + placement.height, 9);
  });

  it('drops straight down when the block spans the point horizontally', () => {
    const placement = placeCallout(200, 250, area, 400, 24);
    expect(placement.x).toBe(0);
    expect(placement.width).toBe(400);
    expect(placement.leaderX).toBeCloseTo(200, 9);
    expect(placement.leaderY).toBeCloseTo(placement.y + placement.height, 9);
  });
});
