import { describe, expect, it } from 'vitest';
import { celsiusToKelvin } from '@/core/units';
import {
  formatCelsius,
  formatCelsiusWithUnit,
  formatDecayExpression,
  formatFixed,
  formatLambda,
  formatMillimetres,
  formatMillimetresWithUnit,
  formatPercent,
  formatRSquared,
  formatSquareCentimetres,
  formatWatts,
  metresToMillimetres,
  NO_VALUE,
  squareMetresToSquareCentimetres,
} from './format';

describe('unit conversion', () => {
  it('converts metres to millimetres', () => {
    expect(metresToMillimetres(0.061)).toBeCloseTo(61, 9);
  });

  it('converts square metres to square centimetres', () => {
    expect(squareMetresToSquareCentimetres(0.02)).toBeCloseTo(200, 9);
  });
});

describe('temperature labels', () => {
  it('never lets a kelvin number reach a label', () => {
    expect(formatCelsius(celsiusToKelvin(200))).toBe('200');
    expect(formatCelsiusWithUnit(celsiusToKelvin(55))).toBe('55 °C');
    expect(formatCelsius(celsiusToKelvin(76.6), 1)).toBe('76.6');
  });

  it('handles sub-ambient and sub-zero temperatures', () => {
    expect(formatCelsiusWithUnit(celsiusToKelvin(-40))).toBe('-40 °C');
    expect(formatCelsiusWithUnit(273.15)).toBe('0 °C');
  });

  it('reports a missing value as a dash, not NaN', () => {
    expect(formatCelsius(NaN)).toBe(NO_VALUE);
    expect(formatCelsiusWithUnit(Infinity)).toBe(NO_VALUE);
  });
});

describe('formatFixed', () => {
  it('does not print a negative zero', () => {
    expect(formatFixed(-0, 0)).toBe('0');
    expect(formatFixed(-0.0001, 2)).toBe('-0.00');
  });

  it('clamps absurd precision instead of throwing', () => {
    expect(formatFixed(1, 500)).toContain('1.');
    expect(formatFixed(1, -3)).toBe('1');
  });
});

describe('length labels', () => {
  it('prints millimetres from metres', () => {
    expect(formatMillimetres(0.061)).toBe('61');
    expect(formatMillimetresWithUnit(0.046)).toBe('46 mm');
    expect(formatMillimetresWithUnit(0.0046, 1)).toBe('4.6 mm');
  });
});

describe('formatWatts', () => {
  it('scales the unit to keep the number readable', () => {
    expect(formatWatts(61)).toBe('61.0 W');
    expect(formatWatts(1234)).toBe('1.23 kW');
    expect(formatWatts(0.42)).toBe('420 mW');
    expect(formatWatts(4.2e-5)).toBe('42.0 µW');
  });

  it('collapses float dust to zero', () => {
    expect(formatWatts(1e-12)).toBe('0 W');
    expect(formatWatts(0)).toBe('0 W');
  });

  it('keeps the sign of a negative flow', () => {
    expect(formatWatts(-61)).toBe('-61.0 W');
  });

  it('reports a non-finite value as a dash', () => {
    expect(formatWatts(NaN)).toBe(NO_VALUE);
  });
});

describe('formatSquareCentimetres', () => {
  it('quotes surface area in cm²', () => {
    expect(formatSquareCentimetres(0.0182)).toBe('182 cm²');
    expect(formatSquareCentimetres(0)).toBe('0 cm²');
  });

  it('does not round a small but non-zero area away to nothing', () => {
    expect(formatSquareCentimetres(1e-7)).toBe('<0.1 cm²');
  });
});

describe('formatPercent', () => {
  it('prints a fraction as a percentage', () => {
    expect(formatPercent(0.1234)).toBe('12%');
    expect(formatPercent(0.1234, 1)).toBe('12.3%');
    expect(formatPercent(NaN)).toBe(NO_VALUE);
  });
});

describe('fit labels', () => {
  it('writes the fit the way the reference figure writes it', () => {
    const fit = { lambda: 0.046, tInfinity: celsiusToKelvin(35), deltaT: 160 };
    expect(formatDecayExpression(fit)).toBe('35 + 160·e^(−s/46 mm)');
    expect(formatLambda(fit.lambda)).toBe('λ = 46 mm');
  });

  it('gives a short fin length a decimal place', () => {
    expect(formatLambda(0.0046)).toBe('λ = 4.6 mm');
  });

  it('prints goodness of fit', () => {
    expect(formatRSquared(0.9817)).toBe('r² = 0.982');
    expect(formatRSquared(NaN)).toContain(NO_VALUE);
  });
});
