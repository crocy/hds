/**
 * Natural-convection correlations against textbook values, and the sign rule that
 * makes sub-ambient work without a second code path.
 */

import { describe, expect, it } from 'vitest';
import { modelFromMesh, stripMesh } from '../core/testModels';
import { DEFAULT_SOLVER_SETTINGS } from '../core/types';
import type { Cavity, Part, Scenario, ThermalModel } from '../core/types';
import {
  airPropertiesAt,
  classifyConvection,
  clampConvectionH,
  computeConvectionCoefficients,
  GRAVITY,
  H_MAX,
  H_MIN,
  naturalConvectionH,
  normaliseGravity,
  nusseltNumber,
  partLengthScales,
  rayleighNumber,
} from './convection';

const AMBIENT = 300;

function scenarioWith(overrides: Partial<Scenario> = {}): Scenario {
  return {
    ambient: AMBIENT,
    gravity: [0, 0, -1],
    partOverrides: {},
    boundaryConditions: [],
    contacts: [],
    cavities: [],
    colorScale: { mode: 'auto', min: 0, max: 0, map: 'inferno' },
    solver: { ...DEFAULT_SOLVER_SETTINGS },
    ...overrides,
  };
}

function uniformField(model: ThermalModel, value: number): Float32Array {
  return new Float32Array(model.nodeCount).fill(value);
}

describe('air properties', () => {
  it('returns the table entry exactly at a tabulated temperature', () => {
    const air = airPropertiesAt(300);
    expect(air.k).toBeCloseTo(0.02624, 10);
    expect(air.nu).toBeCloseTo(15.89e-6, 12);
    expect(air.prandtl).toBeCloseTo(0.707, 10);
    expect(air.beta).toBeCloseTo(1 / 300, 12);
  });

  it('interpolates linearly between entries', () => {
    const air = airPropertiesAt(325);
    expect(air.k).toBeCloseTo((0.02624 + 0.03003) / 2, 10);
    expect(air.nu).toBeCloseTo((15.89e-6 + 20.92e-6) / 2, 12);
    expect(air.prandtl).toBeCloseTo((0.707 + 0.7) / 2, 10);
  });

  it('clamps to the ends of the table rather than extrapolating', () => {
    expect(airPropertiesAt(50).k).toBeCloseTo(airPropertiesAt(200).k, 12);
    expect(airPropertiesAt(5000).k).toBeCloseTo(airPropertiesAt(800).k, 12);
    // β still tracks the real film temperature — it is 1/T, not a table lookup.
    expect(airPropertiesAt(5000).beta).toBeCloseTo(1 / 5000, 12);
  });
});

describe('Rayleigh number', () => {
  it('matches g·β·ΔT·L³·Pr/ν² computed by hand', () => {
    const air = airPropertiesAt(300);
    const ra = rayleighNumber(20, 0.1, air);
    expect(ra).toBeCloseTo(1830631.94, 0);
    expect(ra).toBeCloseTo((GRAVITY * air.beta * 20 * 0.1 ** 3 * air.prandtl) / air.nu ** 2, 6);
  });

  it('uses |ΔT|, so the sign lives in the regime and not in Ra', () => {
    const air = airPropertiesAt(300);
    expect(rayleighNumber(-20, 0.1, air)).toBeCloseTo(rayleighNumber(20, 0.1, air), 6);
  });

  it('scales with the cube of the length scale', () => {
    const air = airPropertiesAt(300);
    expect(rayleighNumber(20, 0.2, air) / rayleighNumber(20, 0.1, air)).toBeCloseTo(8, 6);
  });
});

describe('Nusselt correlations', () => {
  it('matches Churchill–Chu for a vertical plate', () => {
    // {0.825 + 0.387·Ra^(1/6)/[1 + (0.492/Pr)^(9/16)]^(8/27)}² at Ra = 1e6, Pr = 0.71.
    expect(nusseltNumber('vertical', 1e6, 0.71)).toBeCloseTo(16.5584, 3);
    expect(nusseltNumber('vertical', 1e9, 0.7)).toBeCloseTo(122.615, 2);
  });

  it('matches the horizontal-plate correlations either side of the turbulent knee', () => {
    expect(nusseltNumber('horizontalUnstable', 1e6, 0.71)).toBeCloseTo(0.54 * 1e6 ** 0.25, 9);
    expect(nusseltNumber('horizontalUnstable', 1e6, 0.71)).toBeCloseTo(17.0763, 3);
    expect(nusseltNumber('horizontalUnstable', 1e8, 0.71)).toBeCloseTo(69.6238, 3);
    expect(nusseltNumber('horizontalStable', 1e6, 0.71)).toBeCloseTo(8.5381, 3);
  });

  it('convects about half as well on the stable branch', () => {
    const ratio =
      nusseltNumber('horizontalUnstable', 1e5, 0.71) / nusseltNumber('horizontalStable', 1e5, 0.71);
    expect(ratio).toBeCloseTo(2, 6);
  });

  it('never returns a negative Nu for a negative Ra', () => {
    expect(nusseltNumber('horizontalUnstable', -1, 0.71)).toBe(0);
    expect(nusseltNumber('vertical', -1, 0.71)).toBeCloseTo(0.825 ** 2, 9);
  });
});

describe('regime classification', () => {
  // Gravity points down, so a normal with n·ĝ < 0 faces up.
  const facingUp = -1;
  const facingDown = 1;

  it('mirrors hot and cold: the branch depends on the sign of ΔT', () => {
    expect(classifyConvection(facingUp, 350, AMBIENT)).toBe('horizontalUnstable');
    expect(classifyConvection(facingUp, 250, AMBIENT)).toBe('horizontalStable');
    expect(classifyConvection(facingDown, 350, AMBIENT)).toBe('horizontalStable');
    expect(classifyConvection(facingDown, 250, AMBIENT)).toBe('horizontalUnstable');
  });

  it('treats near-tangent normals as vertical whatever the sign of ΔT', () => {
    expect(classifyConvection(0, 350, AMBIENT)).toBe('vertical');
    expect(classifyConvection(0, 250, AMBIENT)).toBe('vertical');
    expect(classifyConvection(0.33, 350, AMBIENT)).toBe('vertical');
    expect(classifyConvection(0.35, 350, AMBIENT)).toBe('horizontalStable');
  });

  it('puts a surface exactly at ambient on the hot side of the branch', () => {
    expect(classifyConvection(facingUp, AMBIENT, AMBIENT)).toBe('horizontalUnstable');
  });
});

describe('natural convection film coefficient', () => {
  it('gives a textbook value for a 0.3 m vertical plate 50 K above ambient', () => {
    // Film 325 K → Ra = 8.46e7, Nu = 58.0, h = Nu·k/L = 58.0 × 0.028135 / 0.3.
    expect(naturalConvectionH(350, 300, 'vertical', 0.3)).toBeCloseTo(5.442, 3);
  });

  it('gives the same magnitude 50 K below ambient on the mirrored branch', () => {
    const hot = naturalConvectionH(350, 300, 'horizontalUnstable', 0.05);
    const cold = naturalConvectionH(250, 300, 'horizontalUnstable', 0.05);
    // Not equal — air properties are evaluated at the film temperature — but close.
    expect(cold / hot).toBeGreaterThan(0.9);
    expect(cold / hot).toBeLessThan(1.3);
    expect(cold).toBeGreaterThan(0);
  });

  it('clamps the correlation into [H_MIN, H_MAX]', () => {
    expect(naturalConvectionH(300.000001, 300, 'vertical', 0.3)).toBe(H_MIN);
    expect(naturalConvectionH(2000, 300, 'horizontalUnstable', 5)).toBeLessThanOrEqual(H_MAX);
    expect(clampConvectionH(Number.NaN)).toBe(H_MIN);
    expect(clampConvectionH(1e9)).toBe(H_MAX);
    expect(clampConvectionH(37)).toBe(37);
  });
});

describe('length scales', () => {
  const part = {
    bbox: { min: [0, 0, 0], max: [0.1, 0.2, 0.3] },
  } as unknown as Part;

  it('takes the extent along gravity as the vertical scale and A/P as the horizontal one', () => {
    const scales = partLengthScales(part, [0, 0, -1]);
    expect(scales.vertical).toBeCloseTo(0.3, 9);
    expect(scales.horizontal).toBeCloseTo((0.1 * 0.2) / (2 * (0.1 + 0.2)), 9);
  });

  it('follows gravity when it points along another axis', () => {
    expect(partLengthScales(part, [0, -1, 0]).vertical).toBeCloseTo(0.2, 9);
    expect(partLengthScales(part, [-1, 0, 0]).vertical).toBeCloseTo(0.1, 9);
  });

  it('normalises gravity and falls back to Z-down for a zero vector', () => {
    expect(normaliseGravity([0, 0, -2])).toEqual([0, 0, -1]);
    expect(normaliseGravity([0, 0, 0])).toEqual([0, 0, -1]);
    const diagonal = normaliseGravity([1, 1, 0]);
    expect(Math.hypot(...diagonal)).toBeCloseTo(1, 9);
  });
});

describe('per-triangle coefficients', () => {
  function plate(): ThermalModel {
    return modelFromMesh(stripMesh(0.2, 0.1, 2, 1));
  }

  it('prefers an explicit h over the correlation and does not clamp it', () => {
    const model = plate();
    const fixedH = new Float32Array(model.triCount).fill(Number.NaN);
    fixedH[0] = 0.25;
    const h = computeConvectionCoefficients(
      model,
      scenarioWith(),
      uniformField(model, 400),
      fixedH,
    );
    expect(h[0]).toBeCloseTo(0.25, 9);
    expect(h[1]).toBeGreaterThanOrEqual(H_MIN);
  });

  it('prefers a cavity condition over the correlation, and adiabatic means zero', () => {
    const model = plate();
    const cavity: Cavity = {
      id: 1,
      name: 'inside',
      condition: 'stillAir',
      h: 2.5,
      emissivity: 0.4,
      fillK: 0.026,
      triCount: 1,
    };
    model.triCavity[0] = 1;
    model.triCavity[1] = 2;
    const scenario = scenarioWith({
      cavities: [cavity, { ...cavity, id: 2, condition: 'adiabatic' }],
    });
    const h = computeConvectionCoefficients(model, scenario, uniformField(model, 400));
    expect(h[0]).toBeCloseTo(2.5, 6);
    expect(h[1]).toBe(0);
  });

  it('zeroes insulator parts', () => {
    const model = plate();
    const scenario = scenarioWith({ partOverrides: { 'part-0': { bodyType: 'insulator' } } });
    const h = computeConvectionCoefficients(model, scenario, uniformField(model, 400));
    for (let t = 0; t < model.triCount; t++) expect(h[t]).toBe(0);
  });

  it('picks the stable branch for a cold plate facing up and the unstable one when hot', () => {
    const model = plate();
    const scenario = scenarioWith();
    // stripMesh winds its triangles so the normals point +Z, i.e. up.
    expect(model.triNormal[2]).toBeCloseTo(1, 6);
    const hot = computeConvectionCoefficients(model, scenario, uniformField(model, 350));
    const cold = computeConvectionCoefficients(model, scenario, uniformField(model, 250));
    for (let t = 0; t < model.triCount; t++) {
      expect(cold[t]).toBeLessThan(hot[t]);
      expect(cold[t]).toBeGreaterThan(0);
    }
  });

  it('reuses the output array when one of the right size is passed in', () => {
    const model = plate();
    const out = new Float32Array(model.triCount);
    const h = computeConvectionCoefficients(
      model,
      scenarioWith(),
      uniformField(model, 350),
      null,
      out,
    );
    expect(h).toBe(out);
  });
});
