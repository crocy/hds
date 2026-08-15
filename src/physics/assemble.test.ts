/**
 * DOF mapping, target resolution, cotangent weights and the assembled system.
 *
 * The cotangent cases are hand-computed, including an obtuse triangle where the
 * negative-weight clamp has to fire.
 */

import { describe, expect, it } from 'vitest';
import { modelFromMesh, stripMesh, twoStripModel } from '../core/testModels';
import { DEFAULT_SOLVER_SETTINGS } from '../core/types';
import type { BoundaryCondition, Scenario, ThermalModel } from '../core/types';
import {
  applyFixedTemperatures,
  assembleSystem,
  buildDofMap,
  convectionOverrides,
  cotangentWeights,
  partIndexOf,
  resolveTargetNodes,
  resolveTargetTriangles,
  surfaceCoefficients,
} from './assemble';

const AMBIENT = 300;
/** testModels defaults: SS304 at 1 mm. */
const KT = 14.9 * 0.001;

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

/** No surface exchange, so the matrix is the bare conduction Laplacian. */
function bareConduction(partIds: string[], extra: BoundaryCondition[] = []): Scenario {
  const partOverrides: Scenario['partOverrides'] = {};
  const boundaryConditions: BoundaryCondition[] = [];
  for (const partId of partIds) {
    partOverrides[partId] = { finishId: 'no-radiation' };
    boundaryConditions.push({
      id: `film-${partId}`,
      kind: 'convection',
      target: { type: 'part', partId },
      h: 0,
      enabled: true,
    });
  }
  return scenarioWith({ partOverrides, boundaryConditions: [...boundaryConditions, ...extra] });
}

function triangleModel(positions: number[]): ThermalModel {
  return modelFromMesh({ positions, indices: [0, 1, 2], partOf: [0], faceOf: [0] });
}

function ambientField(model: ThermalModel): Float32Array {
  return new Float32Array(model.nodeCount).fill(AMBIENT);
}

describe('cotangentWeights', () => {
  it('is zero opposite a right angle and ½ opposite the 45° corners', () => {
    // a = (0,0), b = (1,0), c = (0,1): the right angle sits at a.
    const weights = cotangentWeights([0, 0, 0, 1, 0, 0, 0, 1, 0], 0, 1, 2);
    expect(weights[0]).toBeCloseTo(0, 12);
    expect(weights[1]).toBeCloseTo(0.5, 12);
    expect(weights[2]).toBeCloseTo(0.5, 12);
  });

  it('is cot(60°)/2 on every edge of an equilateral triangle', () => {
    const h = Math.sqrt(3) / 2;
    const weights = cotangentWeights([0, 0, 0, 1, 0, 0, 0.5, h, 0], 0, 1, 2);
    const expected = 1 / (2 * Math.sqrt(3));
    for (let i = 0; i < 3; i++) expect(weights[i]).toBeCloseTo(expected, 12);
  });

  it('goes negative opposite an obtuse angle', () => {
    // a = (0,0), b = (4,0), c = (1,1): the angle at c is obtuse, so the weight of the
    // edge opposite it — a–b, index 2 — is negative. Σ2w = (a²+b²+c²)/4A = 28/8.
    const weights = cotangentWeights([0, 0, 0, 4, 0, 0, 1, 1, 0], 0, 1, 2);
    expect(weights[0]).toBeCloseTo(0.5, 12);
    expect(weights[1]).toBeCloseTo(1.5, 12);
    expect(weights[2]).toBeCloseTo(-0.25, 12);
    expect(2 * (weights[0] + weights[1] + weights[2])).toBeCloseTo(3.5, 12);
  });

  it('returns zeros for a degenerate triangle instead of dividing by zero', () => {
    const weights = cotangentWeights([0, 0, 0, 1, 0, 0, 2, 0, 0], 0, 1, 2);
    expect(Array.from(weights)).toEqual([0, 0, 0]);
  });

  it('writes into the supplied output array', () => {
    const out = new Float64Array(3);
    expect(cotangentWeights([0, 0, 0, 1, 0, 0, 0, 1, 0], 0, 1, 2, out)).toBe(out);
  });
});

describe('negative-weight clamp', () => {
  it('drops the obtuse edge from the matrix instead of adding a positive off-diagonal', () => {
    const model = triangleModel([0, 0, 0, 4, 0, 0, 1, 1, 0]);
    const scenario = bareConduction(['part-0']);
    const dofs = buildDofMap(model, scenario);
    const system = assembleSystem(
      model,
      scenario,
      dofs,
      surfaceCoefficients(model, scenario, ambientField(model)),
    );

    // Unclamped, the −0.25 weight on edge a–b would land as a POSITIVE off-diagonal,
    // which is what breaks diagonal dominance and lets the field overshoot.
    expect(system.matrix.get(0, 1)).toBe(0);
    expect(system.matrix.get(1, 0)).toBe(0);
    expect(system.matrix.get(1, 2)).toBeCloseTo(-KT * 0.5, 12);
    expect(system.matrix.get(2, 0)).toBeCloseTo(-KT * 1.5, 12);
    // Dropping the edge keeps the row sums at zero, so a uniform field is still a
    // solution of the conduction operator.
    for (let row = 0; row < 3; row++) {
      let sum = 0;
      for (let p = system.matrix.rowPtr[row]; p < system.matrix.rowPtr[row + 1]; p++) {
        sum += system.matrix.values[p];
      }
      expect(sum).toBeCloseTo(0, 12);
    }
  });
});

describe('buildDofMap', () => {
  it('gives every sheet node its own DOF', () => {
    const model = modelFromMesh(stripMesh(0.1, 0.05, 2, 1));
    const dofs = buildDofMap(model, scenarioWith());
    expect(dofs.dofCount).toBe(model.nodeCount);
    for (let node = 0; node < model.nodeCount; node++) expect(dofs.nodeDof[node]).toBe(node);
  });

  it('collapses a lump part onto one shared DOF', () => {
    const model = modelFromMesh(stripMesh(0.1, 0.05, 2, 1));
    const dofs = buildDofMap(
      model,
      scenarioWith({ partOverrides: { 'part-0': { bodyType: 'lump' } } }),
    );
    expect(dofs.dofCount).toBe(1);
    for (let node = 0; node < model.nodeCount; node++) expect(dofs.nodeDof[node]).toBe(0);
    expect(dofs.dofPart[0]).toBe(0);
  });

  it('drops insulator nodes out of the system entirely', () => {
    const model = twoStripModel(0.1, 0.02, 3);
    const dofs = buildDofMap(
      model,
      scenarioWith({ partOverrides: { 'part-1': { bodyType: 'insulator' } } }),
    );
    let solvable = 0;
    for (let node = 0; node < model.nodeCount; node++) {
      if (model.nodePart[node] === 1) expect(dofs.nodeDof[node]).toBe(-1);
      else solvable++;
    }
    expect(dofs.dofCount).toBe(solvable);
  });

  it('mixes body types across parts without renumbering the wrong one', () => {
    const model = twoStripModel(0.1, 0.02, 3);
    const dofs = buildDofMap(
      model,
      scenarioWith({ partOverrides: { 'part-0': { bodyType: 'lump' } } }),
    );
    const part1Nodes = Array.from(model.nodePart).filter((part) => part === 1).length;
    expect(dofs.dofCount).toBe(1 + part1Nodes);
    expect(dofs.dofPart[0]).toBe(0);
  });
});

describe('target resolution', () => {
  const model = twoStripModel(0.1, 0.02, 4);

  it('finds a part by id and returns nothing for an unknown one', () => {
    expect(partIndexOf(model, 'part-1')).toBe(1);
    expect(partIndexOf(model, 'nope')).toBe(-1);
    expect(resolveTargetNodes(model, { type: 'part', partId: 'nope' })).toHaveLength(0);
  });

  it('resolves a part target to exactly that part’s nodes', () => {
    const nodes = resolveTargetNodes(model, { type: 'part', partId: 'part-1' });
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) expect(model.nodePart[node]).toBe(1);
  });

  it('resolves a face target to the nodes of that face only', () => {
    const nodes = resolveTargetNodes(model, { type: 'face', partId: 'part-1', faceId: 1 });
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) expect(model.nodePart[node]).toBe(1);
    expect(resolveTargetNodes(model, { type: 'face', partId: 'part-1', faceId: 99 })).toHaveLength(
      0,
    );
  });

  it('resolves an edge chain, ignoring repeats and out-of-range nodes', () => {
    const withEdges = twoStripModel(0.1, 0.02, 4);
    withEdges.featureEdges.push({
      id: 7,
      partIndex: 0,
      nodes: Uint32Array.of(0, 1, 1, 99999),
    });
    expect(
      Array.from(resolveTargetNodes(withEdges, { type: 'edge', partId: 'part-0', edgeId: 7 })),
    ).toEqual([0, 1]);
    expect(
      resolveTargetNodes(withEdges, { type: 'edge', partId: 'part-0', edgeId: 8 }),
    ).toHaveLength(0);
  });

  it('resolves a node target and rejects an out-of-range id', () => {
    expect(
      Array.from(resolveTargetNodes(model, { type: 'node', partId: 'part-0', nodeId: 3 })),
    ).toEqual([3]);
    expect(resolveTargetNodes(model, { type: 'node', partId: 'part-0', nodeId: 1e9 })).toHaveLength(
      0,
    );
  });

  it('gives edge and node targets every incident triangle, since they have no area', () => {
    const tris = resolveTargetTriangles(model, { type: 'node', partId: 'part-0', nodeId: 0 });
    expect(tris.length).toBeGreaterThan(0);
    for (const t of tris) {
      const corners = [model.tris[t * 3], model.tris[t * 3 + 1], model.tris[t * 3 + 2]];
      expect(corners).toContain(0);
    }
  });

  it('maps a face target straight onto its triangles', () => {
    const tris = resolveTargetTriangles(model, { type: 'face', partId: 'part-1', faceId: 1 });
    expect(tris.length).toBe(model.triCount / 2);
    for (const t of tris) expect(model.triPart[t]).toBe(1);
  });
});

describe('surface coefficients', () => {
  it('marks untargeted triangles NaN so the correlation still runs there', () => {
    const model = twoStripModel(0.1, 0.02, 2);
    const scenario = scenarioWith({
      boundaryConditions: [
        {
          id: 'film',
          kind: 'convection',
          target: { type: 'part', partId: 'part-0' },
          h: 7,
          enabled: true,
        },
        {
          id: 'auto',
          kind: 'convection',
          target: { type: 'part', partId: 'part-1' },
          h: 'auto',
          enabled: true,
        },
      ],
    });
    const overrides = convectionOverrides(model, scenario);
    for (let t = 0; t < model.triCount; t++) {
      if (model.triPart[t] === 0) expect(overrides[t]).toBe(7);
      else expect(Number.isNaN(overrides[t])).toBe(true);
    }

    const coefficients = surfaceCoefficients(model, scenario, ambientField(model));
    expect(coefficients.hConv[0]).toBe(7);
    // Bare metal, ε = 0.15, linearised at T = T∞ = 300 K: h_rad = 4εσT³.
    expect(coefficients.hRad[0]).toBeCloseTo(4 * 0.15 * 5.670374419e-8 * AMBIENT ** 3, 6);
  });

  it('ignores disabled conditions', () => {
    const model = twoStripModel(0.1, 0.02, 2);
    const scenario = scenarioWith({
      boundaryConditions: [
        {
          id: 'film',
          kind: 'convection',
          target: { type: 'part', partId: 'part-0' },
          h: 7,
          enabled: false,
        },
      ],
    });
    expect(Number.isNaN(convectionOverrides(model, scenario)[0])).toBe(true);
  });
});

describe('assembleSystem', () => {
  it('stays symmetric and folds the film coefficient into the diagonal and the RHS', () => {
    const model = modelFromMesh(stripMesh(0.1, 0.05, 2, 1), [{ finishId: 'no-radiation' }]);
    const scenario = scenarioWith({
      partOverrides: { 'part-0': { finishId: 'no-radiation' } },
      boundaryConditions: [
        {
          id: 'film',
          kind: 'convection',
          target: { type: 'part', partId: 'part-0' },
          h: 8,
          enabled: true,
        },
      ],
    });
    const dofs = buildDofMap(model, scenario);
    const system = assembleSystem(
      model,
      scenario,
      dofs,
      surfaceCoefficients(model, scenario, ambientField(model)),
    );

    for (let row = 0; row < system.dofCount; row++) {
      for (let p = system.matrix.rowPtr[row]; p < system.matrix.rowPtr[row + 1]; p++) {
        const col = system.matrix.colIndex[p];
        expect(system.matrix.get(col, row)).toBeCloseTo(system.matrix.values[p], 12);
      }
      // b = h·A·T∞ node by node, and the surface term is the row sum of A.
      expect(system.rhs[row]).toBeCloseTo(8 * model.nodeArea[row] * AMBIENT, 6);
      let rowSum = 0;
      for (let p = system.matrix.rowPtr[row]; p < system.matrix.rowPtr[row + 1]; p++) {
        rowSum += system.matrix.values[p];
      }
      expect(rowSum).toBeCloseTo(8 * model.nodeArea[row], 9);
    }
  });

  it('adds contact conductance between the paired DOFs', () => {
    const model = twoStripModel(0.1, 0.02, 2);
    const scenario = bareConduction(['part-0', 'part-1']);
    scenario.contacts = [
      {
        id: 'joint',
        partA: 'part-0',
        partB: 'part-1',
        nodePairs: Uint32Array.of(2, 6),
        pairArea: Float32Array.of(0.5),
        conductance: 10,
        autoDetected: false,
        enabled: true,
      },
    ];
    const dofs = buildDofMap(model, scenario);
    const system = assembleSystem(
      model,
      scenario,
      dofs,
      surfaceCoefficients(model, scenario, ambientField(model)),
    );
    expect(system.matrix.get(2, 6)).toBeCloseTo(-5, 12);
    expect(system.matrix.get(6, 2)).toBeCloseTo(-5, 12);

    scenario.contacts[0].enabled = false;
    const without = assembleSystem(
      model,
      scenario,
      dofs,
      surfaceCoefficients(model, scenario, ambientField(model)),
    );
    expect(without.matrix.get(2, 6)).toBe(0);
  });

  it('splits a heat load over the target by node area', () => {
    const model = modelFromMesh(stripMesh(0.1, 0.05, 2, 1));
    const scenario = scenarioWith({
      boundaryConditions: [
        {
          id: 'load',
          kind: 'heatLoad',
          target: { type: 'part', partId: 'part-0' },
          watts: 6,
          enabled: true,
        },
      ],
    });
    const dofs = buildDofMap(model, scenario);
    const system = assembleSystem(
      model,
      scenario,
      dofs,
      surfaceCoefficients(model, scenario, ambientField(model)),
    );

    let total = 0;
    let area = 0;
    for (let node = 0; node < model.nodeCount; node++) area += model.nodeArea[node];
    for (let dof = 0; dof < dofs.dofCount; dof++) total += system.loadPerDof[dof];
    expect(total).toBeCloseTo(6, 9);
    for (let node = 0; node < model.nodeCount; node++) {
      expect(system.loadPerDof[dofs.nodeDof[node]]).toBeCloseTo(
        (6 * model.nodeArea[node]) / area,
        9,
      );
    }
  });

  it('warns rather than silently discarding a load with nowhere to go', () => {
    const model = modelFromMesh(stripMesh(0.1, 0.05, 2, 1));
    const scenario = scenarioWith({
      partOverrides: { 'part-0': { bodyType: 'insulator' } },
      boundaryConditions: [
        {
          id: 'load',
          kind: 'heatLoad',
          target: { type: 'part', partId: 'part-0' },
          watts: 6,
          enabled: true,
        },
      ],
    });
    const dofs = buildDofMap(model, scenario);
    const system = assembleSystem(
      model,
      scenario,
      dofs,
      surfaceCoefficients(model, scenario, ambientField(model)),
    );
    expect(system.warnings.join('\n')).toContain('matched no solvable nodes');
    expect(system.warnings.join('\n')).toContain('6 W is unused');
  });

  it('warns when two fixed temperatures fight over one DOF', () => {
    const model = modelFromMesh(stripMesh(0.1, 0.05, 2, 1));
    const scenario = scenarioWith({
      boundaryConditions: [
        {
          id: 'hot',
          kind: 'fixedTemp',
          target: { type: 'node', partId: 'part-0', nodeId: 0 },
          value: 400,
          enabled: true,
        },
        {
          id: 'hotter',
          kind: 'fixedTemp',
          target: { type: 'node', partId: 'part-0', nodeId: 0 },
          value: 500,
          enabled: true,
        },
      ],
    });
    const dofs = buildDofMap(model, scenario);
    const system = assembleSystem(
      model,
      scenario,
      dofs,
      surfaceCoefficients(model, scenario, ambientField(model)),
    );
    expect(system.warnings.join('\n')).toContain('Conflicting fixed temperatures');
    expect(system.fixedValue[0]).toBe(500);
  });

  it('pins a DOF that exchanges heat with nothing instead of solving a singular row', () => {
    // Zero thickness kills conduction, h = 0 kills convection, ε = 0 kills radiation.
    const model = modelFromMesh(stripMesh(0.1, 0.05, 1, 1), [{ thickness: 0 }]);
    const scenario = bareConduction(['part-0']);
    const dofs = buildDofMap(model, scenario);
    const system = assembleSystem(
      model,
      scenario,
      dofs,
      surfaceCoefficients(model, scenario, ambientField(model)),
    );
    expect(system.warnings.join('\n')).toContain('exchange no heat with anything');
    for (let dof = 0; dof < system.dofCount; dof++) {
      expect(system.fixed[dof]).toBe(1);
      expect(system.fixedValue[dof]).toBe(AMBIENT);
    }
  });
});

describe('applyFixedTemperatures', () => {
  it('turns fixed rows into identity rows and folds the value into the free ones', () => {
    const model = modelFromMesh(stripMesh(0.1, 0.05, 2, 1));
    const scenario = scenarioWith({
      boundaryConditions: [
        {
          id: 'hot',
          kind: 'fixedTemp',
          target: { type: 'node', partId: 'part-0', nodeId: 0 },
          value: 400,
          enabled: true,
        },
      ],
    });
    const dofs = buildDofMap(model, scenario);
    const system = assembleSystem(
      model,
      scenario,
      dofs,
      surfaceCoefficients(model, scenario, ambientField(model)),
    );
    const coupling = system.matrix.get(1, 0);
    expect(coupling).toBeLessThan(0);
    const rhsBefore = system.rhs[1];

    const { matrix, rhs } = applyFixedTemperatures(system);

    expect(matrix.get(0, 0)).toBe(1);
    for (let p = matrix.rowPtr[0]; p < matrix.rowPtr[0 + 1]; p++) {
      if (matrix.colIndex[p] !== 0) expect(matrix.values[p]).toBe(0);
    }
    expect(rhs[0]).toBe(400);
    expect(matrix.get(1, 0)).toBe(0);
    expect(rhs[1]).toBeCloseTo(rhsBefore - coupling * 400, 9);

    // Symmetric elimination: the eliminated matrix is still SPD-shaped.
    for (let row = 0; row < matrix.size; row++) {
      for (let p = matrix.rowPtr[row]; p < matrix.rowPtr[row + 1]; p++) {
        expect(matrix.get(matrix.colIndex[p], row)).toBeCloseTo(matrix.values[p], 12);
      }
    }
    // …and the original is untouched, so the injected power can still be recovered.
    expect(system.matrix.get(1, 0)).toBeCloseTo(coupling, 12);
    expect(system.rhs[1]).toBeCloseTo(rhsBefore, 12);
  });
});
