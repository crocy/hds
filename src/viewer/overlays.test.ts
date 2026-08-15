import { describe, expect, it } from 'vitest';
import type { BoundaryCondition, Contact, ThermalModel } from '@/core/types';
import { twoStripModel } from '@/core/testModels';
import { PERFECT_CONTACT } from '@/core/types';
import {
  OVERLAY_COLORS,
  OVERLAY_KINDS,
  OVERLAY_LABELS,
  boundaryConditionGeometry,
  cavityFaceTriangles,
  contactNodes,
  contactPatchTriangles,
} from './overlays';

/** The seam of `twoStripModel`: the coincident node columns of the two strips. */
function seamContact(model: ThermalModel, nx = 50): Contact {
  const perStrip = 2 * (nx + 1);
  const pairs: number[] = [];
  for (let row = 0; row < 2; row++) {
    const left = row * (nx + 1) + nx;
    const right = perStrip + row * (nx + 1);
    pairs.push(left, right);
  }
  return {
    id: 'seam',
    partA: model.parts[0].id,
    partB: model.parts[1].id,
    nodePairs: Uint32Array.from(pairs),
    pairArea: Float32Array.from([1e-4, 1e-4]),
    conductance: PERFECT_CONTACT,
    autoDetected: true,
    enabled: true,
  };
}

function countNodesInTriangle(model: ThermalModel, tri: number, nodes: Set<number>): number {
  let hits = 0;
  for (let k = 0; k < 3; k++) if (nodes.has(model.tris[tri * 3 + k])) hits++;
  return hits;
}

describe('overlay legend constants', () => {
  it('gives every kind a distinct colour and a label', () => {
    const colors = OVERLAY_KINDS.map((kind) => OVERLAY_COLORS[kind]);
    expect(new Set(colors).size).toBe(OVERLAY_KINDS.length);
    for (const kind of OVERLAY_KINDS) expect(OVERLAY_LABELS[kind].length).toBeGreaterThan(0);
  });
});

describe('contactNodes', () => {
  it('deduplicates the pair list', () => {
    const contact = seamContact(twoStripModel());
    contact.nodePairs = Uint32Array.from([7, 9, 7, 9, 7, 11]);
    expect(Array.from(contactNodes(contact)).sort((a, b) => a - b)).toEqual([7, 9, 11]);
  });
});

describe('contactPatchTriangles', () => {
  it('finds every triangle with an edge in the patch, on both parts', () => {
    const model = twoStripModel();
    const contact = seamContact(model);
    const nodes = new Set<number>(contact.nodePairs);
    const patch = contactPatchTriangles(model, contact);

    expect(patch.length).toBeGreaterThan(0);
    for (const tri of patch)
      expect(countNodesInTriangle(model, tri, nodes)).toBeGreaterThanOrEqual(2);

    let expected = 0;
    for (let tri = 0; tri < model.triCount; tri++) {
      if (countNodesInTriangle(model, tri, nodes) >= 2) expected++;
    }
    expect(patch.length).toBe(expected);

    const parts = new Set(Array.from(patch, (tri) => model.triPart[tri]));
    expect(parts).toEqual(new Set([0, 1]));
  });

  it('ignores a contact naming a part the model does not have', () => {
    const model = twoStripModel();
    const contact = { ...seamContact(model), partA: 'ghost', partB: 'phantom' };
    expect(contactPatchTriangles(model, contact)).toHaveLength(0);
  });

  it('draws nothing from a single isolated node, which has no edge in the patch', () => {
    const model = twoStripModel();
    const contact = seamContact(model);
    contact.nodePairs = Uint32Array.from([0, 2 * 51]);
    expect(contactPatchTriangles(model, contact)).toHaveLength(0);
    expect(contactNodes(contact)).toHaveLength(2);
  });
});

describe('cavityFaceTriangles', () => {
  it('selects inside-facing triangles, by cavity or all of them', () => {
    const model = twoStripModel();
    model.triCavity[3] = 1;
    model.triCavity[4] = 2;
    expect(Array.from(cavityFaceTriangles(model))).toEqual([3, 4]);
    expect(Array.from(cavityFaceTriangles(model, 2))).toEqual([4]);
    expect(cavityFaceTriangles(model, 7)).toHaveLength(0);
  });

  it('is empty when nothing faces a cavity', () => {
    expect(cavityFaceTriangles(twoStripModel())).toHaveLength(0);
  });
});

describe('boundaryConditionGeometry', () => {
  const model = twoStripModel();

  const fixedOnPart: BoundaryCondition = {
    id: 'bc-fixed',
    kind: 'fixedTemp',
    target: { type: 'part', partId: model.parts[0].id },
    value: 473,
    enabled: true,
  };
  const loadOnNode: BoundaryCondition = {
    id: 'bc-load',
    kind: 'heatLoad',
    target: { type: 'node', partId: model.parts[1].id, nodeId: 120 },
    watts: 5,
    enabled: true,
  };

  it('collects only the requested kind', () => {
    const fixed = boundaryConditionGeometry(model, [fixedOnPart, loadOnNode], 'fixedTemp');
    const [triStart, triEnd] = model.parts[0].triRange;
    expect(fixed.triangles).toHaveLength(triEnd - triStart);
    expect(fixed.paths).toHaveLength(0);

    const load = boundaryConditionGeometry(model, [fixedOnPart, loadOnNode], 'heatLoad');
    expect(load.triangles).toHaveLength(0);
    expect(load.nodes).toEqual([120]);
  });

  it('skips disabled conditions, because they are not in the solve either', () => {
    const geometry = boundaryConditionGeometry(
      model,
      [{ ...fixedOnPart, enabled: false }],
      'fixedTemp',
    );
    expect(geometry.triangles).toHaveLength(0);
    expect(geometry.nodes).toHaveLength(0);
  });

  it('unions several conditions of the same kind', () => {
    const both = boundaryConditionGeometry(
      model,
      [fixedOnPart, { ...fixedOnPart, id: 'bc-2', target: { type: 'part', partId: 'part-1' } }],
      'fixedTemp',
    );
    expect(both.triangles).toHaveLength(model.triCount);
  });
});
