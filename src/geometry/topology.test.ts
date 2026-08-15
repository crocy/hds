import { describe, expect, it } from 'vitest';
import { boxMesh, mergeMeshes, stripMesh } from '../core/testModels';
import { buildThermalModel } from './build';
import type { ImportedMesh } from './importers';
import {
  buildEdgeAdjacency,
  connectedComponents,
  faceRegions,
  featureEdgeChains,
} from './topology';

type RawMesh = ReturnType<typeof boxMesh>;

/**
 * Topology is contractually defined on a *welded* mesh, so the fixtures go
 * through the real welder rather than a second one written for the tests.
 */
function welded(mesh: RawMesh, partNames: string[]) {
  const imported: ImportedMesh = {
    positions: Float64Array.from(mesh.positions),
    indices: Uint32Array.from(mesh.indices),
    triPart: Uint32Array.from(mesh.partOf),
    triFace: null,
    partNames,
    units: 'm',
    derivePartsFromComponents: false,
  };
  return buildThermalModel(imported);
}

describe('buildEdgeAdjacency', () => {
  it('shares the diagonal of a two-triangle quad and leaves four boundary edges', () => {
    const tris = Uint32Array.from([0, 1, 2, 0, 2, 3]);
    const adjacency = buildEdgeAdjacency(tris, 4);

    expect(adjacency.edgeCount).toBe(5);
    const shared = [...adjacency.edgeUseCount].filter((count) => count === 2);
    const boundary = [...adjacency.edgeUseCount].filter((count) => count === 1);
    expect(shared).toHaveLength(1);
    expect(boundary).toHaveLength(4);
  });
});

describe('connectedComponents', () => {
  it('splits two disjoint boxes into two components', () => {
    const model = welded(mergeMeshes(boxMesh([1, 1, 1]), boxMesh([1, 1, 1], [5, 0, 0])), ['both']);
    const split = connectedComponents(model.tris, model.nodeCount);

    expect(split.count).toBe(2);
    expect(new Set(split.triComponent)).toEqual(new Set([0, 1]));
  });

  it('keeps a single closed shell in one component', () => {
    const model = welded(boxMesh([1, 2, 3]), ['box']);
    expect(connectedComponents(model.tris, model.nodeCount).count).toBe(1);
  });
});

describe('faceRegions', () => {
  it('finds exactly six regions on a box', () => {
    const model = welded(boxMesh([1, 2, 3]), ['box']);
    const regions = faceRegions(model.tris, model.nodeCount, model.triNormal);

    expect(regions.count).toBe(6);
    // Each box side is two triangles, merged across their coplanar diagonal.
    const sizes = new Map<number, number>();
    for (const face of regions.triFace) sizes.set(face, (sizes.get(face) ?? 0) + 1);
    expect([...sizes.values()]).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it('keeps a flat strip as a single region', () => {
    const model = welded(stripMesh(1, 1, 4, 4), ['strip']);
    expect(faceRegions(model.tris, model.nodeCount, model.triNormal).count).toBe(1);
  });
});

describe('featureEdgeChains', () => {
  it('gives a box its twelve edges', () => {
    const model = welded(boxMesh([1, 2, 3]), ['box']);
    const chains = featureEdgeChains(model.tris, model.nodeCount, model.triNormal, model.triPart);

    expect(chains).toHaveLength(12);
    for (const chain of chains) {
      expect(chain.nodes).toHaveLength(2);
      expect(chain.partIndex).toBe(0);
    }
    expect(chains.map((chain) => chain.id)).toEqual([...Array(12).keys()]);
  });

  it('chains the open rim of a flat strip into one closed loop', () => {
    const model = welded(stripMesh(1, 1, 2, 2), ['strip']);
    const chains = featureEdgeChains(model.tris, model.nodeCount, model.triNormal, model.triPart);

    expect(chains).toHaveLength(1);
    const loop = chains[0].nodes;
    expect(loop).toHaveLength(9);
    expect(loop[0]).toBe(loop[loop.length - 1]);
  });
});
