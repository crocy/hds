import { describe, expect, it } from 'vitest';
import { finModel, twoStripModel } from '../core/testModels';
import type { Contact } from '../core/types';
import {
  analysePathLength,
  buildConductionGraph,
  dijkstra,
  fitExponentialDecay,
  type ConductionGraph,
} from './pathLength';

/** CSR graph from an undirected edge list, for hand-checked cases. */
function graphFromEdges(
  nodeCount: number,
  edges: ReadonlyArray<readonly [number, number, number]>,
): ConductionGraph {
  const degree = new Uint32Array(nodeCount);
  for (const [a, b] of edges) {
    degree[a]++;
    degree[b]++;
  }
  const offsets = new Uint32Array(nodeCount + 1);
  for (let n = 0; n < nodeCount; n++) offsets[n + 1] = offsets[n] + degree[n];
  const cursor = offsets.slice(0, nodeCount);
  const targets = new Uint32Array(offsets[nodeCount]);
  const weights = new Float64Array(offsets[nodeCount]);
  for (const [a, b, w] of edges) {
    targets[cursor[a]] = b;
    weights[cursor[a]++] = w;
    targets[cursor[b]] = a;
    weights[cursor[b]++] = w;
  }
  return { offsets, targets, weights };
}

describe('dijkstra', () => {
  it('finds the known shortest paths in a hand-built graph', () => {
    //   0 --1-- 1 --2-- 2
    //   |               |
    //   4 ------------- 3 (via 4: 0-4 = 1, 4-3 = 1, 3-2 = 1)
    const graph = graphFromEdges(5, [
      [0, 1, 1],
      [1, 2, 2],
      [0, 4, 1],
      [4, 3, 1],
      [3, 2, 1],
    ]);
    const distance = dijkstra(graph, [0]);
    expect(Array.from(distance)).toEqual([0, 1, 3, 2, 1]);
  });

  it('initialises every source at zero', () => {
    const graph = graphFromEdges(4, [
      [0, 1, 5],
      [1, 2, 5],
      [2, 3, 5],
    ]);
    expect(Array.from(dijkstra(graph, [0, 3]))).toEqual([0, 5, 5, 0]);
  });

  it('reports unreachable nodes as Infinity', () => {
    const graph = graphFromEdges(3, [[0, 1, 1]]);
    expect(dijkstra(graph, [0])[2]).toBe(Infinity);
  });

  it('walks a strip in mesh-edge steps', () => {
    const model = finModel(0.3, 0.02, 0.001, 30);
    const distance = dijkstra(buildConductionGraph(model), [0]);
    // Node 30 is the far end of the first row: 30 steps of 10 mm.
    expect(distance[30]).toBeCloseTo(0.3, 6);
  });
});

describe('paths across a contact', () => {
  const length = 0.1;
  const nx = 50;
  const model = twoStripModel(length, 0.02, nx);

  /** Weld the right end of the left strip to the left end of the right strip. */
  function seamContact(): Contact {
    const pairs: number[] = [];
    const areas: number[] = [];
    const rightEndOfLeft = [nx, 2 * nx + 1];
    const leftEndOfRight = [(nx + 1) * 2, (nx + 1) * 2 + (nx + 1)];
    for (let i = 0; i < rightEndOfLeft.length; i++) {
      pairs.push(rightEndOfLeft[i], leftEndOfRight[i]);
      areas.push(1e-5);
    }
    return {
      id: 'seam',
      partA: 'part-0',
      partB: 'part-1',
      nodePairs: new Uint32Array(pairs),
      pairArea: new Float32Array(areas),
      conductance: 1e6,
      autoDetected: false,
      enabled: true,
    };
  }

  it('leaves the second part unreachable without a contact', () => {
    const distance = dijkstra(buildConductionGraph(model, []), [0]);
    const farEnd = (nx + 1) * 2 + nx;
    expect(distance[farEnd]).toBe(Infinity);
  });

  it('crosses the contact with the right total distance', () => {
    const contact = seamContact();
    // The paired nodes are coincident, so the contact link itself costs nothing.
    expect(contact.nodePairs.length).toBe(4);
    const distance = dijkstra(buildConductionGraph(model, [contact]), [0]);
    const farEnd = (nx + 1) * 2 + nx;
    expect(distance[farEnd]).toBeCloseTo(2 * length, 6);
  });

  it('ignores disabled contacts', () => {
    const contact = { ...seamContact(), enabled: false };
    const distance = dijkstra(buildConductionGraph(model, [contact]), [0]);
    expect(distance[(nx + 1) * 2 + nx]).toBe(Infinity);
  });
});

describe('fitExponentialDecay', () => {
  const trueLambda = 0.046;
  const ambient = 293.15;

  function syntheticField(count: number, noise = 0): { s: Float64Array; t: Float64Array } {
    const s = new Float64Array(count);
    const t = new Float64Array(count);
    // Deterministic pseudo-noise so the test cannot flake.
    let seed = 12345;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
    };
    for (let i = 0; i < count; i++) {
      s[i] = (i / (count - 1)) * 0.3;
      t[i] = ambient + 160 * Math.exp(-s[i] / trueLambda) + noise * random();
    }
    return { s, t };
  }

  it('recovers lambda exactly from clean data', () => {
    const { s, t } = syntheticField(400);
    const fit = fitExponentialDecay(s, t, { tInfinity: ambient });
    expect(fit).not.toBeNull();
    expect(fit!.lambda).toBeCloseTo(trueLambda, 8);
    expect(fit!.deltaT).toBeCloseTo(160, 5);
    expect(fit!.tInfinity).toBeCloseTo(ambient, 4);
    expect(fit!.rSquared).toBeGreaterThan(0.999999);
  });

  it('recovers lambda with the asymptote pinned', () => {
    const { s, t } = syntheticField(400);
    const fit = fitExponentialDecay(s, t, { tInfinity: ambient, refineTInfinity: false });
    expect(fit!.lambda).toBeCloseTo(trueLambda, 9);
    expect(fit!.tInfinity).toBe(ambient);
  });

  it('finds an asymptote above ambient when the field levels off there', () => {
    const count = 400;
    const s = new Float64Array(count);
    const t = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      s[i] = (i / (count - 1)) * 0.3;
      t[i] = ambient + 15 + 160 * Math.exp(-s[i] / trueLambda);
    }
    const fit = fitExponentialDecay(s, t, { tInfinity: ambient });
    expect(fit!.tInfinity).toBeCloseTo(ambient + 15, 3);
    expect(fit!.lambda).toBeCloseTo(trueLambda, 6);
  });

  it('degrades gracefully under noise', () => {
    const { s, t } = syntheticField(400, 8);
    const fit = fitExponentialDecay(s, t, { tInfinity: ambient });
    expect(fit).not.toBeNull();
    expect(Number.isFinite(fit!.lambda)).toBe(true);
    expect(Number.isFinite(fit!.rSquared)).toBe(true);
    expect(fit!.lambda).toBeGreaterThan(0.5 * trueLambda);
    expect(fit!.lambda).toBeLessThan(2 * trueLambda);
    expect(fit!.rSquared).toBeGreaterThan(0.9);
    expect(fit!.rSquared).toBeLessThan(1);
  });

  it('subsamples large inputs without moving lambda', () => {
    const { s, t } = syntheticField(50000);
    const fit = fitExponentialDecay(s, t, { tInfinity: ambient, maxFitSamples: 500 });
    expect(fit!.lambda).toBeCloseTo(trueLambda, 6);
  });

  it('returns null rather than NaN for degenerate input', () => {
    expect(fitExponentialDecay([0, 1], [400, 300], { tInfinity: 293 })).toBeNull();
    // Every point at or below the asymptote.
    expect(fitExponentialDecay([0, 1, 2, 3], [280, 280, 280, 280], { tInfinity: 293 })).toBeNull();
    // A constant field has no decay to find.
    expect(fitExponentialDecay([0, 1, 2, 3], [400, 400, 400, 400], { tInfinity: 293 })).toBeNull();
    // Rising with distance is not a fin.
    expect(fitExponentialDecay([0, 1, 2, 3], [300, 320, 340, 360], { tInfinity: 293 })).toBeNull();
  });

  it('ignores unreachable nodes', () => {
    const { s, t } = syntheticField(200);
    const withGaps = Float64Array.from(s);
    withGaps[10] = Infinity;
    withGaps[20] = Infinity;
    const fit = fitExponentialDecay(withGaps, t, { tInfinity: ambient });
    expect(fit!.lambda).toBeCloseTo(trueLambda, 6);
  });
});

describe('analysePathLength', () => {
  it('recovers the fin length of an analytic 1D fin field', () => {
    const model = finModel(0.3, 0.02, 0.001, 300);
    const ambient = 293.15;
    const lambda = 0.046;
    const graph = buildConductionGraph(model);
    const distance = dijkstra(graph, [0, model.nodeCount / 2]);
    const temperature = new Float32Array(model.nodeCount);
    for (let n = 0; n < model.nodeCount; n++) {
      temperature[n] = ambient + 160 * Math.exp(-distance[n] / lambda);
    }
    const result = analysePathLength(model, [0, model.nodeCount / 2], temperature, {
      tInfinity: ambient,
    });
    expect(result.distance.length).toBe(model.nodeCount);
    expect(result.fit!.lambda).toBeCloseTo(lambda, 6);
    expect(result.fit!.rSquared).toBeGreaterThan(0.9999);
  });
});
