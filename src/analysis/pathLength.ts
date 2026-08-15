/**
 * Temperature vs conduction path length — spec §7.2.
 *
 * Dijkstra from the fixed-temperature node set over shell edges plus contact
 * links, then a least-squares fit of T = T∞ + ΔT·exp(−s/λ). λ, the fin length,
 * is the number this plot exists to produce: how far heat actually travels
 * through the metal before convection has taken it away.
 */

import type { Contact, PathLengthResult, ThermalModel } from '../core/types';

/** Undirected adjacency in CSR form. Both directions of every edge are stored. */
export interface ConductionGraph {
  /** Row offsets into `targets`/`weights`. length = nodeCount + 1 */
  offsets: Uint32Array;
  targets: Uint32Array;
  /** Euclidean edge length, metres. */
  weights: Float64Array;
}

export type ExponentialFit = NonNullable<PathLengthResult['fit']>;

export interface ExponentialFitOptions {
  /**
   * Starting value for the asymptote T∞, kelvin — normally `Scenario.ambient`.
   */
  tInfinity: number;
  /**
   * Search for the true asymptote at or above `tInfinity` instead of pinning it.
   * A model with an insulated cavity levels off well above ambient, so the
   * pinned fit reports a λ that is visibly too long. Default true.
   */
  refineTInfinity?: boolean;
  /**
   * Points used by the asymptote search (strided). The reported rSquared always
   * uses every point. Default 20000.
   */
  maxFitSamples?: number;
}

const MIN_FIT_POINTS = 3;
/** Below this the log of (T − T∞) is noise, not signal. */
const MIN_EXCESS_TEMPERATURE = 1e-6;

/**
 * Mesh edges within each part, plus a link for every enabled contact pair so
 * paths can cross between parts. Interior mesh edges are inserted once per
 * incident triangle; the duplicate carries the same weight and is harmless.
 */
export function buildConductionGraph(
  model: ThermalModel,
  contacts: readonly Contact[] = [],
): ConductionGraph {
  const { nodeCount, triCount, tris, nodes } = model;
  const degree = new Uint32Array(nodeCount);

  const countPair = (a: number, b: number) => {
    if (a < nodeCount && b < nodeCount && a !== b) {
      degree[a]++;
      degree[b]++;
    }
  };
  for (let t = 0; t < triCount; t++) {
    const a = tris[t * 3];
    const b = tris[t * 3 + 1];
    const c = tris[t * 3 + 2];
    countPair(a, b);
    countPair(b, c);
    countPair(c, a);
  }
  const activeContacts = contacts.filter((contact) => contact.enabled);
  for (const contact of activeContacts) {
    for (let p = 0; p + 1 < contact.nodePairs.length; p += 2) {
      countPair(contact.nodePairs[p], contact.nodePairs[p + 1]);
    }
  }

  const offsets = new Uint32Array(nodeCount + 1);
  for (let n = 0; n < nodeCount; n++) offsets[n + 1] = offsets[n] + degree[n];
  const total = offsets[nodeCount];
  const targets = new Uint32Array(total);
  const weights = new Float64Array(total);
  const cursor = offsets.slice(0, nodeCount);

  const addPair = (a: number, b: number) => {
    if (a >= nodeCount || b >= nodeCount || a === b) return;
    const w = Math.hypot(
      nodes[a * 3] - nodes[b * 3],
      nodes[a * 3 + 1] - nodes[b * 3 + 1],
      nodes[a * 3 + 2] - nodes[b * 3 + 2],
    );
    targets[cursor[a]] = b;
    weights[cursor[a]] = w;
    cursor[a]++;
    targets[cursor[b]] = a;
    weights[cursor[b]] = w;
    cursor[b]++;
  };
  for (let t = 0; t < triCount; t++) {
    const a = tris[t * 3];
    const b = tris[t * 3 + 1];
    const c = tris[t * 3 + 2];
    addPair(a, b);
    addPair(b, c);
    addPair(c, a);
  }
  for (const contact of activeContacts) {
    for (let p = 0; p + 1 < contact.nodePairs.length; p += 2) {
      addPair(contact.nodePairs[p], contact.nodePairs[p + 1]);
    }
  }

  return { offsets, targets, weights };
}

/** Lazy-deletion binary heap keyed by distance. */
class MinHeap {
  private keys = new Float64Array(1024);
  private items = new Uint32Array(1024);
  size = 0;

  push(key: number, item: number): void {
    if (this.size === this.keys.length) this.grow();
    let i = this.size++;
    this.keys[i] = key;
    this.items[i] = item;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): number {
    const top = this.items[0];
    this.size--;
    if (this.size > 0) {
      this.keys[0] = this.keys[this.size];
      this.items[0] = this.items[this.size];
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.size && this.keys[left] < this.keys[smallest]) smallest = left;
        if (right < this.size && this.keys[right] < this.keys[smallest]) smallest = right;
        if (smallest === i) break;
        this.swap(smallest, i);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const key = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = key;
    const item = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = item;
  }

  private grow(): void {
    const keys = new Float64Array(this.keys.length * 2);
    keys.set(this.keys);
    this.keys = keys;
    const items = new Uint32Array(this.items.length * 2);
    items.set(this.items);
    this.items = items;
  }
}

/** Multi-source shortest path. Unreached nodes keep Infinity. */
export function dijkstra(graph: ConductionGraph, sources: Iterable<number>): Float32Array {
  const nodeCount = graph.offsets.length - 1;
  const distance = new Float64Array(nodeCount).fill(Infinity);
  const settled = new Uint8Array(nodeCount);
  const heap = new MinHeap();

  for (const source of sources) {
    if (source < 0 || source >= nodeCount || distance[source] === 0) continue;
    distance[source] = 0;
    heap.push(0, source);
  }

  while (heap.size > 0) {
    const node = heap.pop();
    if (settled[node]) continue;
    settled[node] = 1;
    const from = graph.offsets[node];
    const to = graph.offsets[node + 1];
    const base = distance[node];
    for (let e = from; e < to; e++) {
      const next = graph.targets[e];
      if (settled[next]) continue;
      const candidate = base + graph.weights[e];
      if (candidate < distance[next]) {
        distance[next] = candidate;
        heap.push(candidate, next);
      }
    }
  }

  return Float32Array.from(distance);
}

interface LogFit {
  lambda: number;
  deltaT: number;
}

/**
 * Weighted linear regression of ln(T − T∞) on s. Weighting by (T − T∞)²
 * counteracts the log's habit of letting near-ambient points dominate.
 */
function fitAtAsymptote(
  distances: Float64Array,
  temperatures: Float64Array,
  tInfinity: number,
): LogFit | null {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let used = 0;
  for (let i = 0; i < distances.length; i++) {
    const excess = temperatures[i] - tInfinity;
    if (excess <= MIN_EXCESS_TEMPERATURE) continue;
    const x = distances[i];
    const y = Math.log(excess);
    const w = excess * excess;
    sw += w;
    sx += w * x;
    sy += w * y;
    sxx += w * x * x;
    sxy += w * x * y;
    used++;
  }
  if (used < MIN_FIT_POINTS) return null;
  const denominator = sw * sxx - sx * sx;
  if (!(Math.abs(denominator) > 0)) return null;
  const slope = (sw * sxy - sx * sy) / denominator;
  if (!(slope < 0)) return null;
  const lambda = -1 / slope;
  const deltaT = Math.exp((sy - slope * sx) / sw);
  if (!Number.isFinite(lambda) || !Number.isFinite(deltaT)) return null;
  return { lambda, deltaT };
}

/**
 * Sum of squares in linear space over *every* sample, including those the log
 * fit had to drop — that is what stops the asymptote search from improving its
 * score by pushing T∞ up until only a handful of hot points remain.
 */
function residualSumOfSquares(
  distances: Float64Array,
  temperatures: Float64Array,
  tInfinity: number,
  fit: LogFit,
): number {
  let sum = 0;
  for (let i = 0; i < distances.length; i++) {
    const predicted = tInfinity + fit.deltaT * Math.exp(-distances[i] / fit.lambda);
    const error = temperatures[i] - predicted;
    sum += error * error;
  }
  return sum;
}

function scoreAsymptote(
  distances: Float64Array,
  temperatures: Float64Array,
  tInfinity: number,
): number {
  const fit = fitAtAsymptote(distances, temperatures, tInfinity);
  if (!fit) return Infinity;
  return residualSumOfSquares(distances, temperatures, tInfinity, fit);
}

const GOLDEN_RATIO = (Math.sqrt(5) - 1) / 2;

/** Coarse scan to bracket the minimum, then golden section inside the bracket. */
function searchAsymptote(
  distances: Float64Array,
  temperatures: Float64Array,
  lo: number,
  hi: number,
): number {
  const scanSteps = 24;
  let bestIndex = 0;
  let bestScore = Infinity;
  for (let i = 0; i <= scanSteps; i++) {
    const candidate = lo + ((hi - lo) * i) / scanSteps;
    const score = scoreAsymptote(distances, temperatures, candidate);
    if (score < bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  if (!Number.isFinite(bestScore)) return lo;

  const step = (hi - lo) / scanSteps;
  let a = lo + Math.max(0, bestIndex - 1) * step;
  let b = lo + Math.min(scanSteps, bestIndex + 1) * step;
  let c = b - GOLDEN_RATIO * (b - a);
  let d = a + GOLDEN_RATIO * (b - a);
  let fc = scoreAsymptote(distances, temperatures, c);
  let fd = scoreAsymptote(distances, temperatures, d);
  for (let i = 0; i < 80 && b - a > 1e-10 * Math.max(1, Math.abs(a)); i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - GOLDEN_RATIO * (b - a);
      fc = scoreAsymptote(distances, temperatures, c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + GOLDEN_RATIO * (b - a);
      fd = scoreAsymptote(distances, temperatures, d);
    }
  }
  return (a + b) / 2;
}

/**
 * Least-squares fit of T = T∞ + ΔT·exp(−s/λ). Returns null rather than NaNs when
 * the data cannot support a decay: too few usable points, no spread in distance,
 * or a non-decaying trend.
 */
export function fitExponentialDecay(
  distance: ArrayLike<number>,
  temperature: ArrayLike<number>,
  options: ExponentialFitOptions,
): ExponentialFit | null {
  const count = Math.min(distance.length, temperature.length);
  const allDistance = new Float64Array(count);
  const allTemperature = new Float64Array(count);
  let valid = 0;
  for (let i = 0; i < count; i++) {
    const s = distance[i];
    const t = temperature[i];
    if (!Number.isFinite(s) || !Number.isFinite(t) || s < 0) continue;
    allDistance[valid] = s;
    allTemperature[valid] = t;
    valid++;
  }
  if (valid < MIN_FIT_POINTS) return null;
  const points = allDistance.subarray(0, valid);
  const values = allTemperature.subarray(0, valid);

  const maxSamples = Math.max(MIN_FIT_POINTS, options.maxFitSamples ?? 20000);
  const stride = Math.max(1, Math.ceil(valid / maxSamples));
  let sampleDistance = points;
  let sampleTemperature = values;
  if (stride > 1) {
    const sampleCount = Math.ceil(valid / stride);
    sampleDistance = new Float64Array(sampleCount);
    sampleTemperature = new Float64Array(sampleCount);
    for (let i = 0, j = 0; i < valid; i += stride, j++) {
      sampleDistance[j] = points[i];
      sampleTemperature[j] = values[i];
    }
  }

  let maxTemperature = -Infinity;
  for (let i = 0; i < valid; i++) maxTemperature = Math.max(maxTemperature, values[i]);

  const start = options.tInfinity;
  let tInfinity = start;
  if (options.refineTInfinity !== false && maxTemperature > start) {
    // The asymptote can sit anywhere between ambient and the hot end; past 90 %
    // of the way there nothing is left to fit.
    tInfinity = searchAsymptote(
      sampleDistance,
      sampleTemperature,
      start,
      start + 0.9 * (maxTemperature - start),
    );
  }

  const fit = fitAtAsymptote(sampleDistance, sampleTemperature, tInfinity);
  if (!fit) return null;

  let mean = 0;
  for (let i = 0; i < valid; i++) mean += values[i];
  mean /= valid;
  let totalSumOfSquares = 0;
  for (let i = 0; i < valid; i++) {
    const deviation = values[i] - mean;
    totalSumOfSquares += deviation * deviation;
  }
  if (!(totalSumOfSquares > 0)) return null;
  const rSquared = 1 - residualSumOfSquares(points, values, tInfinity, fit) / totalSumOfSquares;
  if (!Number.isFinite(rSquared)) return null;

  return { lambda: fit.lambda, tInfinity, deltaT: fit.deltaT, rSquared };
}

export interface PathLengthOptions extends ExponentialFitOptions {
  contacts?: readonly Contact[];
}

/**
 * Path length from `sources` for every node, plus the decay fit against the
 * supplied field. Targets are resolved to node indices by the caller.
 */
export function analysePathLength(
  model: ThermalModel,
  sources: Iterable<number>,
  temperature: ArrayLike<number>,
  options: PathLengthOptions,
): PathLengthResult {
  const graph = buildConductionGraph(model, options.contacts ?? []);
  const distance = dijkstra(graph, sources);
  return { distance, fit: fitExponentialDecay(distance, temperature, options) };
}
