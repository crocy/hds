import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_ZERO_C,
  celsiusToKelvin,
  fromMetres,
  isLengthUnit,
  kelvinToCelsius,
  LENGTH_UNITS,
  metresPerUnit,
  toMetres,
} from './units';

describe('length units', () => {
  it('scales to metres', () => {
    expect(toMetres(1000, 'mm')).toBeCloseTo(1, 12);
    expect(toMetres(1, 'm')).toBe(1);
    expect(toMetres(1, 'in')).toBeCloseTo(0.0254, 12);
  });

  it('round-trips through metres', () => {
    for (const unit of LENGTH_UNITS) {
      expect(fromMetres(toMetres(123.456, unit), unit)).toBeCloseTo(123.456, 9);
    }
  });

  it('exposes the same factor as toMetres', () => {
    for (const unit of LENGTH_UNITS) {
      expect(toMetres(7, unit)).toBeCloseTo(7 * metresPerUnit(unit), 12);
    }
  });

  it('recognises only the supported units', () => {
    expect(isLengthUnit('mm')).toBe(true);
    expect(isLengthUnit('cm')).toBe(false);
  });
});

describe('temperature', () => {
  it('converts °C to K', () => {
    expect(celsiusToKelvin(0)).toBeCloseTo(273.15, 12);
    expect(celsiusToKelvin(20)).toBeCloseTo(293.15, 12);
    expect(celsiusToKelvin(ABSOLUTE_ZERO_C)).toBeCloseTo(0, 12);
  });

  it('round-trips', () => {
    expect(kelvinToCelsius(celsiusToKelvin(200))).toBeCloseTo(200, 12);
  });
});
