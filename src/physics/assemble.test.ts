/**
 * DOF mapping, target resolution, cotangent weights and the assembled system.
 *
 * The cotangent cases are hand-computed, including an obtuse triangle where the
 * negative-weight clamp has to fire.
 */

import { describe, expect, it } from 'vitest';
import { mergeMeshes, modelFromMesh, stripMesh, twoStripModel } from '../core/testModels';
import { DEFAULT_SOLVER_SETTINGS } from '../core/types';
import type { BoundaryCondition, Cavity, Part, Scenario, ThermalModel } from '../core/types';
import {
  computeNodeEmissivity,
  computeTriangleEmissivity,
  radiationCoefficient,
} from './radiation';
import {
  applyFixedTemperatures,
  assembleSystem,
  buildDofMap,
  conductionThickness,
  convectionOverrides,
  cotangentWeights,
  pairThroughThickness,
  partIndexOf,
  resolveTargetNodes,
  resolveTargetTriangles,
  splitNodeCoefficient,
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

  it('appends one DOF per live cavity after every node DOF', () => {
    const model = modelFromMesh(stripMesh(0.1, 0.05, 2, 1));
    const dofs = buildDofMap(
      model,
      scenarioWith({
        cavities: [
          cavityWith(),
          cavityWith({ id: 2, condition: 'adiabatic' }),
          cavityWith({ id: 3, condition: 'insulated' }),
        ],
      }),
    );

    expect(dofs.nodeDofCount).toBe(model.nodeCount);
    expect(dofs.dofCount).toBe(model.nodeCount + 2);
    expect(dofs.cavityDof[1]).toBe(model.nodeCount);
    expect(dofs.cavityDof[3]).toBe(model.nodeCount + 1);
    // An adiabatic cavity exchanges nothing, so its row would be singular; id 0 is the
    // open-air marker and never names a cavity.
    expect(dofs.cavityDof[2]).toBe(-1);
    expect(dofs.cavityDof[0]).toBe(-1);
    // dofPart stays node-only: nothing walks it past the node DOFs.
    expect(dofs.dofPart.length).toBe(dofs.nodeDofCount);
  });

  it('leaves the count alone when there are no cavities', () => {
    const model = modelFromMesh(stripMesh(0.1, 0.05, 2, 1));
    const dofs = buildDofMap(model, scenarioWith());
    expect(dofs.dofCount).toBe(dofs.nodeDofCount);
    expect(Array.from(dofs.cavityDof)).toEqual([-1]);
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

/**
 * A sheet **solid**: two plates a thickness apart with their normals back to back, the
 * way a tessellated sheet-metal part arrives. Face 0 is the −z plate, face 1 the +z one.
 * `volume` is what marks the mesh as closed, and it is the only thing the pairing and
 * `conductionThickness` read to tell a solid from a mid-surface.
 */
function slabMesh(length: number, width: number, thickness: number, nx: number, topNx = nx) {
  const bottom = stripMesh(length, width, nx, 1, 0, 0);
  // Reverse the winding so the lower plate's normal points −z, away from the upper one.
  for (let t = 0; t * 3 < bottom.indices.length; t++) {
    const swap = bottom.indices[t * 3 + 1];
    bottom.indices[t * 3 + 1] = bottom.indices[t * 3 + 2];
    bottom.indices[t * 3 + 2] = swap;
  }
  const top = stripMesh((length * topNx) / nx, width, topNx, 1, 0, 1, [0, 0, thickness]);
  return mergeMeshes(bottom, top);
}

function slabModel(length: number, width: number, thickness: number, nx: number, topNx = nx) {
  const model = modelFromMesh(slabMesh(length, width, thickness, nx, topNx), [{ thickness }]);
  return { ...model, parts: [{ ...model.parts[0], volume: length * width * thickness }] };
}

describe('pairThroughThickness', () => {
  const length = 0.1;
  const width = 0.02;
  const thickness = 0.001;
  const nx = 10;

  it('matches every node with the one directly opposite it through the sheet', () => {
    const model = slabModel(length, width, thickness, nx);
    const opposite = pairThroughThickness(model, scenarioWith());

    let pairs = 0;
    for (let node = 0; node < model.nodeCount; node++) {
      const twin = opposite[node];
      expect(twin).toBeGreaterThanOrEqual(0);
      // Same in-plane position, one thickness away, and the pairing is an involution.
      expect(model.nodes[twin * 3]).toBeCloseTo(model.nodes[node * 3], 9);
      expect(model.nodes[twin * 3 + 1]).toBeCloseTo(model.nodes[node * 3 + 1], 9);
      expect(Math.abs(model.nodes[twin * 3 + 2] - model.nodes[node * 3 + 2])).toBeCloseTo(
        thickness,
        9,
      );
      expect(opposite[twin]).toBe(node);
      pairs++;
    }
    expect(pairs).toBe(model.nodeCount);
  });

  it('puts both faces of a pair on one DOF, halving the count', () => {
    const model = slabModel(length, width, thickness, nx);
    const opposite = pairThroughThickness(model, scenarioWith());
    const dofs = buildDofMap(model, scenarioWith());

    expect(dofs.dofCount).toBe(model.nodeCount / 2);
    for (let node = 0; node < model.nodeCount; node++) {
      expect(dofs.nodeDof[node]).toBe(dofs.nodeDof[opposite[node]]);
      expect(dofs.dofPart[dofs.nodeDof[node]]).toBe(0);
    }
  });

  it('leaves an open shell alone, because a mid-surface mesh has no second face', () => {
    // Same geometry, `volume` 0: the mesh is now claiming to be a mid-surface, and
    // pairing its two plates would merge two genuinely separate walls.
    const solid = slabModel(length, width, thickness, nx);
    const openShell = { ...solid, parts: [{ ...solid.parts[0], volume: 0 }] };
    expect(Array.from(pairThroughThickness(openShell, scenarioWith()))).toEqual(
      new Array(openShell.nodeCount).fill(-1),
    );
    expect(buildDofMap(openShell, scenarioWith()).dofCount).toBe(openShell.nodeCount);
  });

  it('refuses to pair through a wall that is not the thickness it was told', () => {
    // The plates are 1 mm apart; the scenario says the sheet is 5 mm. Pairing them
    // anyway would silently model a wall the CAD does not contain.
    const model = slabModel(length, width, thickness, nx);
    const scenario = scenarioWith({ partOverrides: { 'part-0': { thickness: 0.005 } } });
    expect(pairThroughThickness(model, scenario).some((twin) => twin >= 0)).toBe(false);
    expect(buildDofMap(model, scenario).dofCount).toBe(model.nodeCount);
  });

  it('pairs what it can and leaves the rest as they were', () => {
    // The upper plate covers only the first half of the lower one — the shape of every
    // real housing, where edge bands, holes and cut-outs never all pair.
    const model = slabModel(length, width, thickness, nx, nx / 2);
    const opposite = pairThroughThickness(model, scenarioWith());
    const dofs = buildDofMap(model, scenarioWith());

    let pairs = 0;
    for (let node = 0; node < model.nodeCount; node++) if (opposite[node] > node) pairs++;
    expect(pairs).toBe(nx + 2); // every node of the shorter upper plate
    expect(dofs.dofCount).toBe(model.nodeCount - pairs);

    // Unpaired nodes keep a DOF of their own; paired ones share.
    const seen = new Map<number, number>();
    for (let node = 0; node < model.nodeCount; node++) {
      seen.set(dofs.nodeDof[node], (seen.get(dofs.nodeDof[node]) ?? 0) + 1);
    }
    for (let node = 0; node < model.nodeCount; node++) {
      expect(seen.get(dofs.nodeDof[node])).toBe(opposite[node] >= 0 ? 2 : 1);
    }
  });

  it('does not pair a lump or an insulator, which have no per-face DOFs to merge', () => {
    const model = slabModel(length, width, thickness, nx);
    for (const bodyType of ['lump', 'insulator'] as const) {
      const scenario = scenarioWith({ partOverrides: { 'part-0': { bodyType } } });
      expect(pairThroughThickness(model, scenario).some((twin) => twin >= 0)).toBe(false);
    }
  });

  it('sums the two half-thickness shells back to the full thickness in plane', () => {
    // The point of the merge: each face conducts k·t/2, and once they share a DOF the
    // two cotangent stencils land in the same equation.
    const model = slabModel(length, width, thickness, nx);
    const scenario = bareConduction(['part-0']);
    const dofs = buildDofMap(model, scenario);
    const merged = assembleSystem(
      model,
      scenario,
      dofs,
      surfaceCoefficients(model, scenario, ambientField(model)),
    );

    const midSurface = modelFromMesh(stripMesh(length, width, nx, 1), [{ thickness }]);
    const midDofs = buildDofMap(midSurface, scenario);
    const single = assembleSystem(
      midSurface,
      scenario,
      midDofs,
      surfaceCoefficients(midSurface, scenario, ambientField(midSurface)),
    );

    expect(merged.matrix.get(0, 1)).toBeCloseTo(single.matrix.get(0, 1), 12);
    expect(merged.matrix.get(0, 1)).toBeLessThan(0);
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
    expect(coefficients.hRadToAmbient[0]).toBeCloseTo(4 * 0.15 * 5.670374419e-8 * AMBIENT ** 3, 6);
    // Nothing faces a cavity here, so the whole coefficient is aimed at the room.
    expect(coefficients.hRadToCavity[0]).toBe(0);
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

/**
 * Two triangles, (0,1,3) and (0,3,2): nodes 0 and 3 are shared, nodes 1 and 2 belong to
 * one triangle each. Put the two triangles in different environments and node 0 is a
 * cavity rim node with a hand-computable split.
 */
function rimModel(): ThermalModel {
  return modelFromMesh(stripMesh(0.1, 0.05, 1, 1));
}

function cavityWith(overrides: Partial<Cavity> = {}): Cavity {
  return {
    id: 1,
    name: 'inside',
    condition: 'stillAir',
    h: 2.5,
    emissivity: 0.4,
    fillK: 0.026,
    triCount: 0,
    ...overrides,
  };
}

/** The single blended value the pre-split carry-over produced: the area-weighted mean. */
function blendOntoNodes(model: ThermalModel, perTriangle: ArrayLike<number>): Float64Array {
  const blended = new Float64Array(model.nodeCount);
  for (let t = 0; t < model.triCount; t++) {
    const share = (perTriangle[t] * model.triArea[t]) / 3;
    for (let c = 0; c < 3; c++) blended[model.tris[t * 3 + c]] += share;
  }
  for (let node = 0; node < model.nodeCount; node++) {
    const area = model.nodeArea[node];
    blended[node] = area > 0 ? blended[node] / area : 0;
  }
  return blended;
}

describe('splitNodeCoefficient', () => {
  it('routes each node’s share by what its triangles face', () => {
    const model = rimModel();
    model.triCavity[0] = 1; // triangle 1 stays open air
    // Cavity 1 is live: its DOF is 4, one past the four node DOFs.
    const split = splitNodeCoefficient(model, [6, 2], Int32Array.of(-1, 4));

    // Node 1 sees only the cavity triangle, node 2 only the open-air one, so each takes
    // its triangle's coefficient whole.
    expect(split.toCavity[1]).toBeCloseTo(6, 6);
    expect(split.toAmbient[1]).toBe(0);
    expect(split.nodeCavity[1]).toBe(1);
    expect(split.toAmbient[2]).toBeCloseTo(2, 6);
    expect(split.toCavity[2]).toBe(0);
    expect(split.nodeCavity[2]).toBe(-1);

    // Nodes 0 and 3 take A/3 from each triangle over a nodeArea of 2A/3, so both shares
    // are halved.
    for (const node of [0, 3]) {
      expect(split.toCavity[node]).toBeCloseTo(3, 6);
      expect(split.toAmbient[node]).toBeCloseTo(1, 6);
      expect(split.nodeCavity[node]).toBe(1);
    }
  });

  it('sends a cavity with no DOF to ambient, exactly as open air', () => {
    // An adiabatic cavity owns no DOF, so there is nothing for its walls to exchange
    // with; routing them to the cavity share would strand their watts.
    const model = rimModel();
    model.triCavity[0] = 1;
    const split = splitNodeCoefficient(model, [6, 2], Int32Array.of(-1, -1));

    expect(split.toAmbient[1]).toBeCloseTo(6, 6);
    for (let node = 0; node < model.nodeCount; node++) {
      expect(split.toCavity[node]).toBe(0);
      expect(split.nodeCavity[node]).toBe(-1);
    }
  });

  it('splits the emissivity computeNodeEmissivity blends, node for node', () => {
    // Invariant 3: no radiating area is created or destroyed by the split.
    const model = modelFromMesh(stripMesh(0.1, 0.05, 3, 2));
    for (const t of [0, 1, 4]) model.triCavity[t] = 1;
    for (const t of [7, 8]) model.triCavity[t] = 2;
    const scenario = scenarioWith({
      cavities: [cavityWith(), cavityWith({ id: 2, condition: 'adiabatic' })],
    });
    // Cavity 2 is adiabatic, so only cavity 1 owns a DOF.
    const split = splitNodeCoefficient(
      model,
      computeTriangleEmissivity(model, scenario),
      Int32Array.of(-1, model.nodeCount, -1),
    );

    const blended = computeNodeEmissivity(model, scenario);
    let cavityFacing = 0;
    for (let node = 0; node < model.nodeCount; node++) {
      expect(split.toAmbient[node] + split.toCavity[node]).toBeCloseTo(blended[node], 12);
      if (split.toCavity[node] > 0) cavityFacing++;
    }
    expect(cavityFacing).toBeGreaterThan(0);
  });

  it('splits the film coefficient the same way, since one helper serves both', () => {
    const model = modelFromMesh(stripMesh(0.1, 0.05, 3, 2));
    for (const t of [0, 1, 4]) model.triCavity[t] = 1;
    const scenario = scenarioWith({ cavities: [cavityWith()] });
    const { hConv } = surfaceCoefficients(model, scenario, ambientField(model));
    const split = splitNodeCoefficient(model, hConv, Int32Array.of(-1, model.nodeCount));

    const blended = blendOntoNodes(model, hConv);
    for (let node = 0; node < model.nodeCount; node++) {
      expect(split.toAmbient[node] + split.toCavity[node]).toBeCloseTo(blended[node], 12);
    }
    // The cavity's own film coefficient really is in there, not the correlation's.
    expect(split.toCavity[model.tris[0]]).toBeGreaterThan(0);
  });

  it('gives a node bridging two cavities wholly to the larger, losing nothing', () => {
    // Node 0 is the shared corner of a 2 m² triangle in cavity 2 and a 0.5 m² one in
    // cavity 1. Splitting its share between the two would be the alternative; assigning
    // it whole keeps the heat inside a sealed pocket either way, and only which pocket
    // is approximate.
    const model = modelFromMesh({
      positions: [0, 0, 0, 2, 0, 0, 0, 2, 0, -1, 0, 0, 0, -1, 0],
      indices: [0, 1, 2, 0, 3, 4],
      partOf: [0, 0],
      faceOf: [0, 0],
    });
    model.triCavity[0] = 2;
    model.triCavity[1] = 1;
    const split = splitNodeCoefficient(model, [3, 9], Int32Array.of(-1, 6, 5));

    expect(split.nodeCavity[0]).toBe(2);
    // (3·2/3 + 9·0.5/3) / (2/3 + 0.5/3) = 3.5 / 0.8333… = 4.2
    expect(split.toCavity[0]).toBeCloseTo(4.2, 5);
    expect(split.toAmbient[0]).toBe(0);
    for (const node of [1, 2]) expect(split.nodeCavity[node]).toBe(2);
    for (const node of [3, 4]) expect(split.nodeCavity[node]).toBe(1);

    // Neither cavity loses any of its coefficient·area to the reassignment.
    let carried = 0;
    for (let node = 0; node < model.nodeCount; node++) {
      carried += split.toCavity[node] * model.nodeArea[node];
    }
    expect(carried).toBeCloseTo(3 * 2 + 9 * 0.5, 5);
  });
});

describe('cavity coupling', () => {
  const FILM = 8;
  /** Warmer than the walls, so the sign of every coupling is visible. */
  const CAVITY_T = 350;

  /** The rim model, triangle 0 facing cavity 1 and triangle 1 open air. */
  function rimScenario(cavity: Partial<Cavity> = {}, film = FILM): Scenario {
    return scenarioWith({
      partOverrides: { 'part-0': { finishId: 'no-radiation' } },
      boundaryConditions: [
        {
          id: 'film',
          kind: 'convection',
          target: { type: 'part', partId: 'part-0' },
          h: film,
          enabled: true,
        },
      ],
      // The same film coefficient on both triangles, so only the routing differs.
      cavities: [cavityWith({ emissivity: 0, ...cavity })],
    });
  }

  function assembleRim(scenario: Scenario) {
    const model = rimModel();
    model.triCavity[0] = 1;
    const dofs = buildDofMap(model, scenario);
    const coefficients = surfaceCoefficients(model, scenario, ambientField(model), {
      dof: dofs.cavityDof,
      temperature: Float64Array.of(AMBIENT, CAVITY_T),
    });
    return { model, dofs, system: assembleSystem(model, scenario, dofs, coefficients) };
  }

  it('couples a cavity wall to the cavity DOF instead of to ambient', () => {
    const { model, dofs, system } = assembleRim(rimScenario());
    const cav = dofs.cavityDof[1];
    const hArea = (FILM * model.triArea[0]) / 3;

    expect(cav).toBe(model.nodeCount);
    // Node 1 sees only the cavity triangle, node 2 only the open-air one.
    expect(system.matrix.get(1, cav)).toBeCloseTo(-hArea, 12);
    expect(system.matrix.get(cav, 1)).toBeCloseTo(-hArea, 12);
    expect(system.rhs[1]).toBe(0);
    expect(system.matrix.get(2, cav)).toBe(0);
    expect(system.rhs[2]).toBeCloseTo(hArea * AMBIENT, 9);
    // Node 0 straddles the rim: its cavity share couples, its open-air share still
    // takes ambient as a source.
    expect(system.matrix.get(0, cav)).toBeCloseTo(-hArea, 12);
    expect(system.rhs[0]).toBeCloseTo(hArea * AMBIENT, 9);
  });

  it('leaves the cavity row without a source term, so what flows in flows back out', () => {
    const { model, dofs, system } = assembleRim(rimScenario());
    const cav = dofs.cavityDof[1];
    const hArea = (FILM * model.triArea[0]) / 3;

    expect(system.rhs[cav]).toBe(0);
    expect(system.matrix.get(cav, cav)).toBeCloseTo(3 * hArea, 12);
    // A zero row sum with a zero RHS is the conservation statement itself: the row
    // reads Σ h·A·(T_wall − T_cavity) = 0 and can say nothing else.
    let rowSum = 0;
    for (let p = system.matrix.rowPtr[cav]; p < system.matrix.rowPtr[cav + 1]; p++) {
      rowSum += system.matrix.values[p];
    }
    expect(rowSum).toBeCloseTo(0, 12);
  });

  it('radiates into the cavity at the cavity’s temperature, not at ambient', () => {
    // Film off, so what lands in the matrix is the radiation term alone.
    const { model, dofs, system } = assembleRim(rimScenario({ emissivity: 0.4 }, 0));
    const cav = dofs.cavityDof[1];

    // 9 decimals, not more: the carry-over divides one float32 area by another, so the
    // emissivity that reaches the matrix is 0.4 to about eight digits.
    expect(system.matrix.get(1, cav)).toBeCloseTo(
      -radiationCoefficient(0.4, AMBIENT, CAVITY_T) * model.nodeArea[1],
      9,
    );
    // Node 0 takes A/3 at ε = 0.4 from the cavity triangle over a nodeArea of 2A/3, and
    // its open-air half radiates nothing, so none of it is aimed at the room.
    expect(system.matrix.get(0, cav)).toBeCloseTo(
      -radiationCoefficient(0.2, AMBIENT, CAVITY_T) * model.nodeArea[0],
      9,
    );
    expect(system.rhs[0]).toBe(0);
    expect(system.rhs[cav]).toBe(0);
  });

  it('stays symmetric with the cavity DOFs in the system', () => {
    const { system } = assembleRim(rimScenario({ emissivity: 0.4 }));
    for (let row = 0; row < system.dofCount; row++) {
      for (let p = system.matrix.rowPtr[row]; p < system.matrix.rowPtr[row + 1]; p++) {
        expect(system.matrix.get(system.matrix.colIndex[p], row)).toBeCloseTo(
          system.matrix.values[p],
          12,
        );
      }
    }
  });

  it('sends a cavity with no DOF to ambient, exactly as open air', () => {
    // An adiabatic cavity has no row to exchange with, so a film coefficient the user
    // set on its wall has nowhere to go but the room, as it did before cavities had one.
    const { model, dofs, system } = assembleRim(rimScenario({ condition: 'adiabatic' }));
    expect(dofs.cavityDof[1]).toBe(-1);
    expect(system.dofCount).toBe(model.nodeCount);
    expect(system.rhs[1]).toBeCloseTo(((FILM * model.triArea[0]) / 3) * AMBIENT, 9);
  });
});

describe('conductionThickness', () => {
  const sheet = (volume: number): Part => ({
    ...modelFromMesh(stripMesh(0.1, 0.05, 1, 1)).parts[0],
    volume,
  });

  it('halves the thickness of a closed solid and leaves an open shell alone', () => {
    // The mesh of a sheet-metal solid carries both faces, so each one conducts half.
    expect(conductionThickness(sheet(1e-6), 0.002)).toBe(0.001);
    expect(conductionThickness(sheet(-1e-6), 0.002)).toBe(0.001);
    expect(conductionThickness(sheet(0), 0.002)).toBe(0.002);
  });

  it('gives a closed solid half the conduction of the same mesh read as a mid-surface', () => {
    const midSurface = modelFromMesh(stripMesh(0.1, 0.05, 2, 1));
    const solid: ThermalModel = {
      ...midSurface,
      parts: [{ ...midSurface.parts[0], volume: 1e-6 }],
    };
    const scenario = bareConduction(['part-0']);
    const conductanceOf = (model: ThermalModel) => {
      const dofs = buildDofMap(model, scenario);
      const system = assembleSystem(
        model,
        scenario,
        dofs,
        surfaceCoefficients(model, scenario, ambientField(model)),
      );
      return system.matrix.get(0, 1);
    };

    expect(conductanceOf(solid)).toBeCloseTo(conductanceOf(midSurface) / 2, 12);
    // Area is untouched: both faces of the sheet really are exposed.
    expect(solid.parts[0].surfaceArea).toBe(midSurface.parts[0].surfaceArea);
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
