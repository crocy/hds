/**
 * The analytical benchmarks from spec §10 — the tests that decide whether the
 * numbers this product prints mean anything.
 *
 * Every solve here also asserts energy conservation, because a field that does not
 * conserve energy is not a wrong answer, it is a meaningless one.
 */

import { describe, expect, it } from 'vitest';
import { finModel, mergeMeshes, modelFromMesh, stripMesh, twoStripModel } from '../core/testModels';
import { DEFAULT_SOLVER_SETTINGS } from '../core/types';
import type {
  BoundaryCondition,
  Contact,
  Scenario,
  SolveResult,
  ThermalModel,
} from '../core/types';
import { heatThroughput, shellSolver, solveShell } from './solve';

const AMBIENT = 300;
const STEFAN_BOLTZMANN = 5.670374419e-8;
/** testModels defaults every part to SS304, 1 mm. */
const SS304_K = 14.9;
const SHEET_THICKNESS = 0.001;

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

function fixedTemp(id: string, partId: string, nodeId: number, value: number): BoundaryCondition {
  return { id, kind: 'fixedTemp', target: { type: 'node', partId, nodeId }, value, enabled: true };
}

function fixedPartTemp(id: string, partId: string, value: number): BoundaryCondition {
  return { id, kind: 'fixedTemp', target: { type: 'part', partId }, value, enabled: true };
}

function fixedFilm(id: string, partId: string, h: number): BoundaryCondition {
  return { id, kind: 'convection', target: { type: 'part', partId }, h, enabled: true };
}

/** The whole left-hand column of a strip mesh, both rows. */
function leftEdgeNodes(nx: number, base = 0): [number, number] {
  return [base, base + nx + 1];
}

function rightEdgeNodes(nx: number, base = 0): [number, number] {
  return [base + nx, base + 2 * nx + 1];
}

function totalArea(model: ThermalModel): number {
  let area = 0;
  for (let t = 0; t < model.triCount; t++) area += model.triArea[t];
  return area;
}

/**
 * Spec §10 benchmark 4, applied to every solve in this file: what goes in must come
 * out. The tolerance is far tighter than the solver's own warning threshold — a
 * balance that only just closes is already telling us something is wrong.
 *
 * Radiating models are held to the same bound as the rest: h_rad is linearised per
 * node, so h_rad·(T − T∞) and εσ(T⁴ − T∞⁴) are the same number by algebra rather than
 * to O(dx²). See 'closes to float32 noise at every mesh density' below.
 */
function expectEnergyConserved(result: SolveResult, relative = 1e-4): void {
  const throughput = heatThroughput(result.balance);
  expect(Math.abs(result.balance.residual)).toBeLessThanOrEqual(
    Math.max(relative * throughput, 1e-6),
  );
  expect(result.warnings.join('\n')).not.toContain('Energy balance does not close');
}

function expectNoNaN(values: Float32Array): void {
  for (let i = 0; i < values.length; i++) expect(Number.isFinite(values[i])).toBe(true);
}

describe('1D fin benchmark', () => {
  // A 150 mm strip, one end held 100 K above ambient, a fixed film coefficient on both
  // faces and radiation switched off, which is exactly the closed form's hypothesis:
  //   T(x) = T∞ + ΔT·cosh(m(L − x))/cosh(mL),  m = √(2h/(k·t))
  // The mesh is a single-sided sheet, so the film coefficient applied to it carries
  // both faces' loss: h_applied = 2·h_face.
  const length = 0.15;
  const nx = 150;
  const hFace = 5;
  const tHot = 400;
  const m = Math.sqrt((2 * hFace) / (SS304_K * SHEET_THICKNESS));

  function solveFin(): { model: ThermalModel; result: SolveResult } {
    const model = finModel(length, 0.02, SHEET_THICKNESS, nx);
    const [a, b] = leftEdgeNodes(nx);
    const scenario = scenarioWith({
      partOverrides: { 'part-0': { finishId: 'no-radiation' } },
      boundaryConditions: [
        fixedFilm('film', 'part-0', 2 * hFace),
        fixedTemp('hot-a', 'part-0', a, tHot),
        fixedTemp('hot-b', 'part-0', b, tHot),
      ],
    });
    return { model, result: solveShell(model, scenario) };
  }

  function analyticAt(x: number): number {
    return AMBIENT + (tHot - AMBIENT) * (Math.cosh(m * (length - x)) / Math.cosh(m * length));
  }

  it('reproduces the analytic temperature profile', () => {
    const { model, result } = solveFin();
    expect(result.converged).toBe(true);
    expectNoNaN(result.temperature);

    let maxError = 0;
    let sumSquares = 0;
    for (let node = 0; node < model.nodeCount; node++) {
      const error = Math.abs(result.temperature[node] - analyticAt(model.nodes[node * 3]));
      maxError = Math.max(maxError, error);
      sumSquares += error * error;
    }
    const rmsError = Math.sqrt(sumSquares / model.nodeCount);

    // Measured: max 4.9e-3 K, RMS 1.1e-3 K against a 100 K drive — the O(dx²) error of
    // linear elements at m·dx = 0.026, not a modelling discrepancy.
    expect(maxError).toBeLessThan(0.02);
    expect(rmsError).toBeLessThan(0.005);
  });

  it('matches the analytic fin heat rate at the root', () => {
    const { result } = solveFin();
    // Q = √(h·P·k·A_c)·ΔT·tanh(mL), adiabatic tip; per width w: √(2h·k·t)·w·ΔT.
    const analytic =
      0.02 *
      Math.sqrt(2 * hFace * SS304_K * SHEET_THICKNESS) *
      (tHot - AMBIENT) *
      Math.tanh(m * length);

    expect(result.balance.injectedAtFixed).toBeCloseTo(analytic, 3);
    expect(Math.abs(result.balance.injectedAtFixed / analytic - 1)).toBeLessThan(1e-3);
    expect(result.balance.lostByRadiation).toBe(0);
    expectEnergyConserved(result);
  });

  it('leaves the tip cooler than the root and never overshoots the fixed end', () => {
    const { model, result } = solveFin();
    expect(result.maxTemp).toBeCloseTo(tHot, 6);
    expect(result.minTemp).toBeGreaterThan(AMBIENT);
    expect(result.minTemp).toBeLessThan(analyticAt(length) + 0.02);
    for (let node = 0; node < model.nodeCount; node++) {
      expect(result.temperature[node]).toBeLessThanOrEqual(tHot + 1e-6);
      expect(result.temperature[node]).toBeGreaterThanOrEqual(AMBIENT - 1e-6);
    }
  });
});

describe('sheet solid benchmark', () => {
  // The same 1D fin, but meshed the way CAD hands over a sheet-metal part: a solid, so
  // the mesh carries both faces. Each face conducts t/2 and convects on its own, and the
  // two are merged onto one DOF per in-plane position because Bi = h·t/k ≈ 7e-4 makes a
  // 1 mm steel sheet isothermal through its thickness.
  //
  // The films are deliberately lopsided — one face open to air, the other a sealed
  // cavity wall — and the drive touches the cavity face only. That is the case the
  // merge exists for: without it the heat entering the inner skin can only spread
  // through k·t/2 and can never reach the open face at all, which is a different
  // physical object from the sheet the CAD describes.
  const length = 0.15;
  const width = 0.02;
  const nx = 60;
  const hOpen = 10;
  const hCavity = 0;
  const tHot = 400;

  /** Two plates a thickness apart, normals back to back. Face 0 is −z, face 1 is +z. */
  function slabFin(): ThermalModel {
    const cavitySide = stripMesh(length, width, nx, 1, 0, 0);
    for (let t = 0; t * 3 < cavitySide.indices.length; t++) {
      const swap = cavitySide.indices[t * 3 + 1];
      cavitySide.indices[t * 3 + 1] = cavitySide.indices[t * 3 + 2];
      cavitySide.indices[t * 3 + 2] = swap;
    }
    const openSide = stripMesh(length, width, nx, 1, 0, 1, [0, 0, SHEET_THICKNESS]);
    const model = modelFromMesh(mergeMeshes(cavitySide, openSide), [
      { thickness: SHEET_THICKNESS, finishId: 'no-radiation' },
    ]);
    return { ...model, parts: [{ ...model.parts[0], volume: length * width * SHEET_THICKNESS }] };
  }

  function solveSlab() {
    const model = slabFin();
    const [a, b] = leftEdgeNodes(nx);
    const scenario = scenarioWith({
      partOverrides: { 'part-0': { finishId: 'no-radiation' } },
      boundaryConditions: [
        {
          id: 'cavity-face',
          kind: 'convection',
          target: { type: 'face', partId: 'part-0', faceId: 0 },
          h: hCavity,
          enabled: true,
        },
        {
          id: 'open-face',
          kind: 'convection',
          target: { type: 'face', partId: 'part-0', faceId: 1 },
          h: hOpen,
          enabled: true,
        },
        fixedTemp('hot-a', 'part-0', a, tHot),
        fixedTemp('hot-b', 'part-0', b, tHot),
      ],
    });
    return { model, result: solveShell(model, scenario) };
  }

  it('carries the full-thickness fin heat rate whichever face the heat enters', () => {
    const { result } = solveSlab();
    // Cross-section w·t, loss w·(h_open + h_cavity) per unit length: the one fin the
    // real sheet is. Reading the mesh as two shells that never meet would give
    // √((h/2)·k·t/2)·… — 41 % low, and on the open face 100 % low.
    const m = Math.sqrt((hOpen + hCavity) / (SS304_K * SHEET_THICKNESS));
    const analytic =
      width *
      Math.sqrt((hOpen + hCavity) * SS304_K * SHEET_THICKNESS) *
      (tHot - AMBIENT) *
      Math.tanh(m * length);
    expect(analytic).toBeCloseTo(0.77136, 5);

    expect(Math.abs(result.balance.injectedAtFixed / analytic - 1)).toBeLessThan(2e-3);
    expectEnergyConserved(result);
  });

  it('holds the two faces at one temperature, which is what Bi ≪ 1 means', () => {
    const { model, result } = solveSlab();
    const perColumn = new Map<number, number[]>();
    for (let node = 0; node < model.nodeCount; node++) {
      const x = Math.round(model.nodes[node * 3] * 1e6);
      const y = Math.round(model.nodes[node * 3 + 1] * 1e6);
      const key = x * 1e6 + y;
      perColumn.set(key, [...(perColumn.get(key) ?? []), result.temperature[node]]);
    }
    for (const temperatures of perColumn.values()) {
      expect(temperatures).toHaveLength(2);
      expect(temperatures[0]).toBe(temperatures[1]);
    }
    // …and the open face really is being fed, rather than sitting at ambient as it
    // would if the two shells were only joined around the rim.
    expect(result.minTemp).toBeGreaterThan(AMBIENT + 1);
  });
});

describe('isothermal plate benchmark', () => {
  // Pinned everywhere, so the only question is whether the balance reports the loss a
  // hand calculation gives: h·A·ΔT + ε·σ·A·(T⁴ − T∞⁴).
  const surfaceT = 400;
  const h = 12;
  const emissivity = 0.9;

  function solvePlate() {
    const model = modelFromMesh(stripMesh(0.2, 0.1, 8, 4), [{ finishId: 'painted' }]);
    const scenario = scenarioWith({
      boundaryConditions: [
        fixedFilm('film', 'part-0', h),
        fixedPartTemp('hot', 'part-0', surfaceT),
      ],
    });
    return { model, result: solveShell(model, scenario) };
  }

  it('loses exactly hAΔT by convection and εσA(T⁴−T∞⁴) by radiation', () => {
    const { model, result } = solvePlate();
    const area = totalArea(model);
    expect(area / 0.02).toBeCloseTo(1, 6);

    const convection = h * area * (surfaceT - AMBIENT);
    const radiation = emissivity * STEFAN_BOLTZMANN * area * (surfaceT ** 4 - AMBIENT ** 4);
    expect(convection).toBeCloseTo(24, 5);
    expect(radiation).toBeCloseTo(17.8617, 3);

    expect(result.balance.lostByConvection / convection).toBeCloseTo(1, 6);
    expect(result.balance.lostByRadiation / radiation).toBeCloseTo(1, 6);
    expect(result.balance.injectedAtFixed / (convection + radiation)).toBeCloseTo(1, 6);
    expectEnergyConserved(result);
  });

  it('attributes the whole loss to the one part and holds it isothermal', () => {
    const { result } = solvePlate();
    expect(result.balance.perPart).toHaveLength(1);
    expect(result.balance.perPart[0].partId).toBe('part-0');
    expect(result.balance.perPart[0].convection + result.balance.perPart[0].radiation).toBeCloseTo(
      result.balance.injectedAtFixed,
      9,
    );
    expect(result.minTemp).toBeCloseTo(surfaceT, 6);
    expect(result.maxTemp).toBeCloseTo(surfaceT, 6);
  });
});

describe('two-part contact benchmark', () => {
  // Two 100 mm strips end to end, hot end fixed, cold end fixed, no surface exchange:
  // a pure series resistance R = L/(k·t·w) + 1/(h_c·A_c) + L/(k·t·w).
  const length = 0.1;
  const width = 0.02;
  const nx = 50;
  const contactConductance = 5000;
  const contactArea = SHEET_THICKNESS * width;
  const tHot = 400;
  const tCold = 300;

  const stripResistance = length / (SS304_K * SHEET_THICKNESS * width);
  const jointResistance = 1 / (contactConductance * contactArea);
  const totalResistance = 2 * stripResistance + jointResistance;
  const expectedWatts = (tHot - tCold) / totalResistance;

  function solveContact(contactEnabled = true) {
    const model = twoStripModel(length, width, nx);
    const upstreamBase = 0;
    const downstreamBase = (nx + 1) * 2;
    const [jointA, jointB] = rightEdgeNodes(nx, upstreamBase);
    const [jointC, jointD] = leftEdgeNodes(nx, downstreamBase);
    const contact: Contact = {
      id: 'joint',
      partA: 'part-0',
      partB: 'part-1',
      nodePairs: Uint32Array.of(jointA, jointC, jointB, jointD),
      pairArea: Float32Array.of(contactArea / 2, contactArea / 2),
      conductance: contactConductance,
      autoDetected: false,
      enabled: contactEnabled,
    };
    const [hotA, hotB] = leftEdgeNodes(nx, upstreamBase);
    const [coldA, coldB] = rightEdgeNodes(nx, downstreamBase);
    const scenario = scenarioWith({
      contacts: [contact],
      partOverrides: {
        'part-0': { finishId: 'no-radiation' },
        'part-1': { finishId: 'no-radiation' },
      },
      boundaryConditions: [
        fixedFilm('no-film-0', 'part-0', 0),
        fixedFilm('no-film-1', 'part-1', 0),
        fixedTemp('hot-a', 'part-0', hotA, tHot),
        fixedTemp('hot-b', 'part-0', hotB, tHot),
        fixedTemp('cold-a', 'part-1', coldA, tCold),
        fixedTemp('cold-b', 'part-1', coldB, tCold),
      ],
    });
    return {
      model,
      contactNodes: { upstream: jointA, downstream: jointC },
      result: solveShell(model, scenario),
    };
  }

  it('carries the analytic series-resistance heat rate across the joint', () => {
    const { result } = solveContact();
    expect(expectedWatts).toBeCloseTo(0.146812, 6);

    expect(result.balance.perContact).toHaveLength(1);
    expect(result.balance.perContact[0].contactId).toBe('joint');
    // 4 decimals, not more: the reported field is Float32Array, and a 1.5 K jump read
    // off 400 K temperatures carries ~1e-5 of relative rounding.
    expect(result.balance.perContact[0].watts / expectedWatts).toBeCloseTo(1, 4);
    expect(result.balance.perPart[0].injected / expectedWatts).toBeCloseTo(1, 4);
    expect(result.balance.perPart[1].injected / -expectedWatts).toBeCloseTo(1, 4);
    // Hot end in, cold end out: the fixed set nets to zero, nothing is lost to ambient.
    expect(result.balance.injectedAtFixed).toBeCloseTo(0, 6);
    expectEnergyConserved(result);
  });

  it('drops the analytic ΔT across the contact itself', () => {
    const { contactNodes, result } = solveContact();
    const jump =
      result.temperature[contactNodes.upstream] - result.temperature[contactNodes.downstream];
    expect(jump / (expectedWatts * jointResistance)).toBeCloseTo(1, 4);
    // …and the analytic ΔT along the strip that feeds it.
    expect(tHot - result.temperature[contactNodes.upstream]).toBeCloseTo(
      expectedWatts * stripResistance,
      4,
    );
  });

  it('carries nothing when the contact is disabled', () => {
    expect(solveContact(true).result.balance.perContact[0].watts).toBeGreaterThan(0);

    const { model, result } = solveContact(false);
    expect(result.balance.perContact).toHaveLength(0);
    // The two strips are now thermally separate: each sits at its own driven value.
    for (let node = 0; node < model.nodeCount; node++) {
      expect(result.temperature[node]).toBeCloseTo(model.nodePart[node] === 0 ? tHot : tCold, 4);
    }
    expect(result.balance.injectedAtFixed).toBeCloseTo(0, 9);
    expectEnergyConserved(result);
  });
});

describe('sub-ambient drive', () => {
  // 50 K below ambient must be as ordinary as 50 K above it: the same code path, a
  // mirrored field and a negative net injected power.
  const length = 0.15;
  const nx = 150;

  function solveDriven(driveT: number): { model: ThermalModel; result: SolveResult } {
    const model = finModel(length, 0.02, SHEET_THICKNESS, nx);
    const [a, b] = leftEdgeNodes(nx);
    const scenario = scenarioWith({
      partOverrides: { 'part-0': { finishId: 'painted' } },
      boundaryConditions: [
        fixedTemp('drive-a', 'part-0', a, driveT),
        fixedTemp('drive-b', 'part-0', b, driveT),
      ],
    });
    return { model, result: solveShell(model, scenario) };
  }

  it('extracts power instead of injecting it, with no NaN anywhere', () => {
    const { result } = solveDriven(AMBIENT - 50);
    expect(result.converged).toBe(true);
    expectNoNaN(result.temperature);

    expect(result.balance.injectedAtFixed).toBeLessThan(0);
    expect(result.balance.lostByConvection).toBeLessThan(0);
    expect(result.balance.lostByRadiation).toBeLessThan(0);
    expect(result.minTemp).toBeCloseTo(AMBIENT - 50, 4);
    expect(result.maxTemp).toBeLessThanOrEqual(AMBIENT);
    expectEnergyConserved(result);
  });

  it('mirrors the above-ambient field without copying it', () => {
    const hot = solveDriven(AMBIENT + 50);
    const cold = solveDriven(AMBIENT - 50);

    // Normalised excess temperature: identical fields would give identical θ.
    let maxDeviation = 0;
    for (let node = 0; node < hot.model.nodeCount; node++) {
      const hotTheta = (hot.result.temperature[node] - AMBIENT) / 50;
      const coldTheta = (AMBIENT - cold.result.temperature[node]) / 50;
      expect(coldTheta).toBeGreaterThan(-1e-6);
      maxDeviation = Math.max(maxDeviation, Math.abs(coldTheta - hotTheta));
    }
    // Close, because nothing branches on the sign of ΔT other than the correlation…
    expect(maxDeviation).toBeLessThan(0.15);
    // …but not identical, because the correlation itself is asymmetric: a cold plate
    // facing up is the stable branch, which convects roughly half as well, so the cold
    // field decays more slowly along the fin.
    expect(maxDeviation).toBeGreaterThan(0.01);

    const mid = Math.round(nx / 2);
    const hotMid = hot.result.temperature[mid] - AMBIENT;
    const coldMid = AMBIENT - cold.result.temperature[mid];
    expect(coldMid).toBeGreaterThan(hotMid);
  });

  it('conserves energy at both signs of ΔT', () => {
    expectEnergyConserved(solveDriven(AMBIENT + 50).result);
    expectEnergyConserved(solveDriven(AMBIENT - 50).result);
  });
});

describe('energy accounting', () => {
  /** Radiating fin, hot enough that radiation dominates, at three mesh densities. */
  function relativeResidualAt(nx: number): number {
    const model = finModel(0.15, 0.02, SHEET_THICKNESS, nx);
    const [a, b] = leftEdgeNodes(nx);
    const scenario = scenarioWith({
      partOverrides: { 'part-0': { finishId: 'painted' } },
      boundaryConditions: [
        fixedTemp('hot-a', 'part-0', a, 600),
        fixedTemp('hot-b', 'part-0', b, 600),
      ],
    });
    const result = solveShell(model, scenario);
    return Math.abs(result.balance.residual) / heatThroughput(result.balance);
  }

  /**
   * All that is left of the residual once radiation is linearised per node: the
   * balance reads its field back out of a Float32Array, and 24-bit temperatures near
   * 600 K cannot account for watts more finely than this. It is a property of the
   * field's storage, not of the mesh.
   */
  const FLOAT32_FIELD_NOISE = 5e-5;

  it('closes to float32 noise at every mesh density, with no dx² tail left', () => {
    // h_rad is linearised at each node's own temperature — the same temperature the
    // balance takes (T − T∞) at — so h_rad·(T − T∞) = εσ(T⁴ − T∞⁴) is an algebraic
    // identity and the two accounts of a watt cannot disagree by construction.
    // Measured: 8.7e-6, 3.7e-7, 5.8e-7, 5.4e-8, 7.4e-7 for nx = 10 … 160, sign
    // random and with no ordering by mesh size. Linearising at each triangle's mean
    // corner temperature instead gave 2.0e-3 → 5.7e-4 → 1.5e-4 for nx = 40 → 160:
    // an O(dx²) discrepancy, always negative because T⁴ is convex, that only
    // refinement could shrink and that no refinement could take this far down.
    for (const nx of [10, 20, 40, 80, 160]) {
      expect(relativeResidualAt(nx)).toBeLessThan(FLOAT32_FIELD_NOISE);
    }
  });

  it('warns loudly rather than hiding a balance that does not close', () => {
    // The threshold is a fraction of throughput, so a model with no throughput at all
    // must not warn on float noise.
    const model = finModel(0.15, 0.02, SHEET_THICKNESS, 20);
    const quiet = solveShell(model, scenarioWith());
    expect(quiet.warnings.join('\n')).not.toContain('Energy balance');
    expect(quiet.balance.residual).toBeCloseTo(0, 12);
  });
});

describe('body types', () => {
  // Radiation off throughout: these are tests of the DOF map, and h·A·ΔT is a number
  // that can be checked by hand to the last digit.
  const film = 10;

  function solveStrip(bodyType: 'sheet' | 'lump', extra: BoundaryCondition[]) {
    const model = finModel(0.15, 0.02, SHEET_THICKNESS, 40);
    const scenario = scenarioWith({
      partOverrides: { 'part-0': { bodyType, finishId: 'no-radiation' } },
      boundaryConditions: [fixedFilm('film', 'part-0', film), ...extra],
    });
    return { model, result: solveShell(model, scenario) };
  }

  const pinOneNode = [fixedTemp('hot', 'part-0', 0, 400)];

  it('spreads one pinned node across a whole lump but not across a sheet', () => {
    const lump = solveStrip('lump', pinOneNode);
    expect(lump.result.maxTemp - lump.result.minTemp).toBe(0);
    expect(lump.result.maxTemp).toBeCloseTo(400, 6);
    expectEnergyConserved(lump.result);

    const sheet = solveStrip('sheet', pinOneNode);
    expect(sheet.result.maxTemp).toBeCloseTo(400, 6);
    expect(sheet.result.maxTemp - sheet.result.minTemp).toBeGreaterThan(50);
    expectEnergyConserved(sheet.result);
  });

  it('sheds h·A·ΔT over the lump’s entire surface, not just the pinned node', () => {
    const { model, result } = solveStrip('lump', pinOneNode);
    const expected = film * totalArea(model) * (400 - AMBIENT);
    expect(expected).toBeCloseTo(3, 5);
    expect(result.balance.injectedAtFixed / expected).toBeCloseTo(1, 6);
    expect(result.balance.lostByRadiation).toBe(0);
  });

  it('holds a loaded lump at the isothermal temperature its area implies', () => {
    const load: BoundaryCondition = {
      id: 'watts',
      kind: 'heatLoad',
      target: { type: 'node', partId: 'part-0', nodeId: 0 },
      watts: 2,
      enabled: true,
    };
    const { model, result } = solveStrip('lump', [load]);
    // One DOF, so 2 W leaves through the whole area: T = T∞ + Q/(h·A).
    const expected = AMBIENT + 2 / (film * totalArea(model));
    expect(expected).toBeCloseTo(366.667, 3);
    expect(result.maxTemp).toBeCloseTo(expected, 3);
    expect(result.balance.injectedAtLoads).toBeCloseTo(2, 9);
    expect(result.balance.lostByConvection / 2).toBeCloseTo(1, 6);
    expectEnergyConserved(result);
  });

  it('drops insulator parts out of the system and reports them at ambient', () => {
    const model = twoStripModel(0.1, 0.02, 20);
    const scenario = scenarioWith({
      partOverrides: { 'part-1': { bodyType: 'insulator' } },
      boundaryConditions: [fixedFilm('film', 'part-0', 10), fixedPartTemp('hot', 'part-0', 400)],
    });
    const result = solveShell(model, scenario);
    expectNoNaN(result.temperature);

    for (let node = 0; node < model.nodeCount; node++) {
      if (model.nodePart[node] === 1) expect(result.temperature[node]).toBe(AMBIENT);
    }
    expect(result.balance.perPart[1].convection).toBe(0);
    expect(result.balance.perPart[1].radiation).toBe(0);
    expect(result.balance.perPart[1].injected).toBe(0);
    expect(result.balance.perPart[0].convection).toBeGreaterThan(0);
    // The excluded part must not appear in the reported extent either.
    expect(result.minTemp).toBeCloseTo(400, 6);
    expectEnergyConserved(result);
  });
});

describe('outer loop', () => {
  /** Hot end pinned, auto convection and full radiation: the coefficients really move. */
  function drivenFin(solver: Partial<Scenario['solver']> = {}) {
    const nx = 60;
    const model = finModel(0.15, 0.02, SHEET_THICKNESS, nx);
    const [a, b] = leftEdgeNodes(nx);
    const scenario = scenarioWith({
      partOverrides: { 'part-0': { finishId: 'painted' } },
      boundaryConditions: [
        fixedTemp('hot-a', 'part-0', a, 600),
        fixedTemp('hot-b', 'part-0', b, 600),
      ],
      solver: { ...DEFAULT_SOLVER_SETTINGS, ...solver },
    });
    return { model, scenario };
  }

  it('warns instead of pretending when the iteration cap is hit', () => {
    const { model, scenario } = drivenFin({ maxOuterIterations: 1, warmStart: false });
    const result = solveShell(model, scenario);
    expect(result.converged).toBe(false);
    expect(result.outerIterations).toBe(1);
    expect(result.warnings.join('\n')).toContain('iteration cap');
  });

  it('warns when CG runs out of iterations', () => {
    const { model, scenario } = drivenFin({ maxCgIterations: 2, cgTolerance: 1e-12 });
    const result = solveShell(model, scenario);
    expect(result.warnings.join('\n')).toContain('Conjugate gradient');
  });

  it('warm-starts from a previous field and lands on the same answer', () => {
    const { model, scenario } = drivenFin();
    const cold = solveShell(model, scenario);
    const warm = solveShell(model, scenario, cold.temperature);

    expect(cold.converged).toBe(true);
    expect(warm.converged).toBe(true);
    expect(warm.outerIterations).toBeLessThan(cold.outerIterations);
    for (let node = 0; node < model.nodeCount; node++) {
      expect(warm.temperature[node]).toBeCloseTo(cold.temperature[node], 3);
    }
    expectEnergyConserved(warm);
  });

  it('ignores a stale previous field of the wrong length', () => {
    const { model, scenario } = drivenFin();
    const reference = solveShell(model, scenario);
    const stale = solveShell(model, scenario, new Float32Array(3).fill(1234));
    for (let node = 0; node < model.nodeCount; node++) {
      expect(stale.temperature[node]).toBeCloseTo(reference.temperature[node], 3);
    }
  });

  it('does not mutate the model or the scenario', () => {
    const { model, scenario } = drivenFin();
    const nodesBefore = Float32Array.from(model.nodes);
    const scenarioBefore = JSON.stringify(scenario.boundaryConditions);
    solveShell(model, scenario);
    expect(Array.from(model.nodes)).toEqual(Array.from(nodesBefore));
    expect(JSON.stringify(scenario.boundaryConditions)).toBe(scenarioBefore);
  });

  it('reports elapsed time and exposes the ThermalSolver seam', async () => {
    const { model, scenario } = drivenFin();
    expect(shellSolver.id).toBe('shell');
    const result = await shellSolver.solve(model, scenario);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.outerIterations).toBeGreaterThan(0);
    expectEnergyConserved(result);
  });
});
