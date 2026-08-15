import { describe, expect, it } from 'vitest';
import { modelFromMesh, stripMesh, twoStripModel } from '../core/testModels';
import { DEFAULT_SOLVER_SETTINGS } from '../core/types';
import type { Contact, Scenario, ThermalModel } from '../core/types';
import { computeHeatBalance, type ConductionEdges, type HeatBalanceInput } from './balance';

const STEFAN_BOLTZMANN = 5.670374419e-8;
const AMBIENT = 300;

function scenarioWith(contacts: Contact[] = []): Scenario {
  return {
    ambient: AMBIENT,
    gravity: [0, 0, -1],
    partOverrides: {},
    boundaryConditions: [],
    contacts,
    cavities: [],
    colorScale: { mode: 'auto', min: AMBIENT, max: 500, map: 'inferno' },
    solver: DEFAULT_SOLVER_SETTINGS,
  };
}

/** Every mesh edge with the same conductance — enough to exercise the accounting. */
function uniformConductionEdges(model: ThermalModel, conductance: number): ConductionEdges {
  const nodes: number[] = [];
  for (let t = 0; t < model.triCount; t++) {
    const a = model.tris[t * 3];
    const b = model.tris[t * 3 + 1];
    const c = model.tris[t * 3 + 2];
    nodes.push(a, b, b, c, c, a);
  }
  return {
    nodes: new Uint32Array(nodes),
    conductance: new Float64Array(nodes.length / 2).fill(conductance),
  };
}

function noEdges(): ConductionEdges {
  return { nodes: new Uint32Array(0), conductance: new Float64Array(0) };
}

function inputFor(
  model: ThermalModel,
  overrides: Partial<HeatBalanceInput> & { temperature: ArrayLike<number> },
): HeatBalanceInput {
  return {
    model,
    scenario: scenarioWith(),
    hConvection: new Float32Array(model.nodeCount),
    emissivity: new Float32Array(model.nodeCount),
    conduction: noEdges(),
    fixedNodes: new Uint32Array(0),
    nodeLoad: new Float32Array(model.nodeCount),
    ...overrides,
  };
}

function totalArea(model: ThermalModel): number {
  let area = 0;
  for (let t = 0; t < model.triCount; t++) area += model.triArea[t];
  return area;
}

describe('computeHeatBalance', () => {
  it('matches the closed form for an isothermal plate held at temperature', () => {
    const model = modelFromMesh(stripMesh(0.2, 0.1, 8, 4));
    const surface = 300;
    const h = 12;
    const emissivity = 0.8;
    const area = totalArea(model);

    const balance = computeHeatBalance(
      inputFor(model, {
        temperature: new Float32Array(model.nodeCount).fill(surface + 100),
        hConvection: new Float32Array(model.nodeCount).fill(h),
        emissivity: new Float32Array(model.nodeCount).fill(emissivity),
        conduction: uniformConductionEdges(model, 5),
        fixedNodes: Uint32Array.from({ length: model.nodeCount }, (_, n) => n),
      }),
    );

    const expectedConvection = h * area * 100;
    const expectedRadiation = emissivity * STEFAN_BOLTZMANN * area * (400 ** 4 - AMBIENT ** 4);
    expect(balance.lostByConvection).toBeCloseTo(expectedConvection, 5);
    expect(balance.lostByRadiation).toBeCloseTo(expectedRadiation, 5);
    expect(balance.injectedAtFixed).toBeCloseTo(expectedConvection + expectedRadiation, 5);
    expect(balance.residual).toBeCloseTo(0, 9);
    expect(balance.perPart).toHaveLength(1);
    expect(balance.perPart[0].partId).toBe('part-0');
    expect(balance.perPart[0].convection).toBeCloseTo(expectedConvection, 5);
  });

  it('closes when heat loads exactly match the surface loss', () => {
    const model = modelFromMesh(stripMesh(0.2, 0.1, 6, 3));
    const h = 20;
    const surface = 350;
    const area = totalArea(model);
    const loss = h * area * (surface - AMBIENT);
    const nodeLoad = new Float32Array(model.nodeCount);
    for (let n = 0; n < model.nodeCount; n++) {
      nodeLoad[n] = (loss * model.nodeArea[n]) / area;
    }

    const balance = computeHeatBalance(
      inputFor(model, {
        temperature: new Float32Array(model.nodeCount).fill(surface),
        hConvection: new Float32Array(model.nodeCount).fill(h),
        nodeLoad,
      }),
    );

    expect(balance.injectedAtLoads).toBeCloseTo(loss, 6);
    expect(balance.injectedAtFixed).toBe(0);
    expect(balance.residual / loss).toBeCloseTo(0, 6);
  });

  it('surfaces a non-zero residual for a field that is not in balance', () => {
    const model = modelFromMesh(stripMesh(0.1, 0.02, 1, 1));
    const temperature = Float32Array.from([400, 350, AMBIENT, AMBIENT]);
    const conductance = 3;
    const balance = computeHeatBalance(
      inputFor(model, {
        temperature,
        conduction: {
          nodes: Uint32Array.from([0, 1]),
          conductance: Float64Array.from([conductance]),
        },
        fixedNodes: Uint32Array.from([0]),
      }),
    );
    expect(balance.injectedAtFixed).toBeCloseTo(conductance * 50, 9);
    expect(balance.residual).toBeCloseTo(conductance * 50, 9);
  });

  it('counts fixed-to-fixed conduction as internal', () => {
    const model = modelFromMesh(stripMesh(0.1, 0.02, 1, 1));
    const balance = computeHeatBalance(
      inputFor(model, {
        temperature: Float32Array.from([400, 350, AMBIENT, AMBIENT]),
        conduction: {
          nodes: Uint32Array.from([0, 1]),
          conductance: Float64Array.from([3]),
        },
        fixedNodes: Uint32Array.from([0, 1]),
      }),
    );
    expect(balance.injectedAtFixed).toBeCloseTo(0, 12);
  });

  it('reports watts crossing each contact, signed A to B', () => {
    const model = twoStripModel(0.1, 0.02, 4);
    const conductance = 500;
    const pairArea = 1e-4;
    const contact: Contact = {
      id: 'seam',
      partA: 'part-0',
      partB: 'part-1',
      nodePairs: Uint32Array.from([4, 10, 9, 15]),
      pairArea: Float32Array.from([pairArea, pairArea]),
      conductance,
      autoDetected: false,
      enabled: true,
    };
    const temperature = new Float32Array(model.nodeCount).fill(AMBIENT);
    temperature[4] = 400;
    temperature[9] = 400;

    const balance = computeHeatBalance(
      inputFor(model, { temperature, scenario: scenarioWith([contact]) }),
    );
    expect(balance.perContact).toHaveLength(1);
    expect(balance.perContact[0].contactId).toBe('seam');
    expect(balance.perContact[0].watts).toBeCloseTo(2 * conductance * pairArea * 100, 5);
  });

  it('includes contact outflow in the power injected at a fixed node', () => {
    const model = twoStripModel(0.1, 0.02, 4);
    const contact: Contact = {
      id: 'seam',
      partA: 'part-0',
      partB: 'part-1',
      nodePairs: Uint32Array.from([4, 10]),
      pairArea: Float32Array.from([1e-4]),
      conductance: 500,
      autoDetected: false,
      enabled: true,
    };
    const temperature = new Float32Array(model.nodeCount).fill(AMBIENT);
    temperature[4] = 400;
    const balance = computeHeatBalance(
      inputFor(model, {
        temperature,
        scenario: scenarioWith([contact]),
        fixedNodes: Uint32Array.from([4]),
      }),
    );
    expect(balance.injectedAtFixed).toBeCloseTo(5, 5);
  });

  it('ignores disabled contacts', () => {
    const model = twoStripModel(0.1, 0.02, 4);
    const contact: Contact = {
      id: 'seam',
      partA: 'part-0',
      partB: 'part-1',
      nodePairs: Uint32Array.from([4, 10]),
      pairArea: Float32Array.from([1e-4]),
      conductance: 500,
      autoDetected: false,
      enabled: false,
    };
    const temperature = new Float32Array(model.nodeCount).fill(AMBIENT);
    temperature[4] = 400;
    const balance = computeHeatBalance(
      inputFor(model, {
        temperature,
        scenario: scenarioWith([contact]),
        fixedNodes: Uint32Array.from([4]),
      }),
    );
    expect(balance.perContact).toHaveLength(0);
    expect(balance.injectedAtFixed).toBe(0);
  });

  it('splits losses per part', () => {
    const model = twoStripModel(0.1, 0.02, 4);
    const temperature = new Float32Array(model.nodeCount).fill(AMBIENT);
    for (let n = 0; n < model.nodeCount; n++) {
      if (model.nodePart[n] === 0) temperature[n] = 400;
    }
    const balance = computeHeatBalance(
      inputFor(model, {
        temperature,
        hConvection: new Float32Array(model.nodeCount).fill(10),
      }),
    );
    expect(balance.perPart).toHaveLength(2);
    expect(balance.perPart[1].convection).toBeCloseTo(0, 12);
    expect(balance.perPart[0].convection).toBeCloseTo(balance.lostByConvection, 5);
    expect(balance.perPart[0].convection).toBeGreaterThan(0);
  });

  it('does not double-count a repeated fixed node', () => {
    const model = modelFromMesh(stripMesh(0.1, 0.02, 1, 1));
    const balance = computeHeatBalance(
      inputFor(model, {
        temperature: Float32Array.from([400, 350, AMBIENT, AMBIENT]),
        conduction: {
          nodes: Uint32Array.from([0, 1]),
          conductance: Float64Array.from([3]),
        },
        fixedNodes: Uint32Array.from([0, 0, 0]),
      }),
    );
    expect(balance.injectedAtFixed).toBeCloseTo(150, 9);
  });
});
