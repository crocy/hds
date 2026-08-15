/**
 * CSR sparse matrix, triplet builder, and Jacobi-preconditioned conjugate gradient.
 *
 * The assembled thermal system is symmetric positive-definite, which is what makes CG
 * the right solver. Everything here is typed arrays: the target is 10k–150k DOF in a
 * browser worker, so per-entry object allocation is not an option.
 */

export class CsrMatrix {
  constructor(
    readonly size: number,
    /** length size + 1 */
    readonly rowPtr: Int32Array,
    readonly colIndex: Int32Array,
    readonly values: Float64Array,
  ) {}

  get nnz(): number {
    return this.rowPtr[this.size];
  }

  multiply(x: Float64Array, out?: Float64Array): Float64Array {
    const y = out && out.length === this.size ? out : new Float64Array(this.size);
    for (let i = 0; i < this.size; i++) {
      let sum = 0;
      for (let p = this.rowPtr[i]; p < this.rowPtr[i + 1]; p++) {
        sum += this.values[p] * x[this.colIndex[p]];
      }
      y[i] = sum;
    }
    return y;
  }

  diagonal(out?: Float64Array): Float64Array {
    const d = out && out.length === this.size ? out : new Float64Array(this.size);
    for (let i = 0; i < this.size; i++) {
      d[i] = 0;
      for (let p = this.rowPtr[i]; p < this.rowPtr[i + 1]; p++) {
        if (this.colIndex[p] === i) {
          d[i] = this.values[p];
          break;
        }
      }
    }
    return d;
  }

  get(row: number, col: number): number {
    for (let p = this.rowPtr[row]; p < this.rowPtr[row + 1]; p++) {
      if (this.colIndex[p] === col) return this.values[p];
    }
    return 0;
  }

  clone(): CsrMatrix {
    return new CsrMatrix(this.size, this.rowPtr, this.colIndex, Float64Array.from(this.values));
  }
}

/**
 * Accumulates (row, col, value) triplets, then compresses to CSR, summing duplicates.
 * Zero values are kept so callers can reserve a diagonal slot that later gets written.
 */
export class SparseBuilder {
  private rows: Int32Array;
  private cols: Int32Array;
  private vals: Float64Array;
  private count = 0;

  constructor(
    readonly size: number,
    initialCapacity = 1024,
  ) {
    const capacity = Math.max(16, initialCapacity);
    this.rows = new Int32Array(capacity);
    this.cols = new Int32Array(capacity);
    this.vals = new Float64Array(capacity);
  }

  get entryCount(): number {
    return this.count;
  }

  add(row: number, col: number, value: number): void {
    if (row < 0 || col < 0 || row >= this.size || col >= this.size) {
      throw new RangeError(`Sparse entry (${row}, ${col}) outside a ${this.size}² matrix`);
    }
    if (this.count === this.rows.length) this.grow();
    this.rows[this.count] = row;
    this.cols[this.count] = col;
    this.vals[this.count] = value;
    this.count++;
  }

  private grow(): void {
    const capacity = this.rows.length * 2;
    const rows = new Int32Array(capacity);
    const cols = new Int32Array(capacity);
    const vals = new Float64Array(capacity);
    rows.set(this.rows);
    cols.set(this.cols);
    vals.set(this.vals);
    this.rows = rows;
    this.cols = cols;
    this.vals = vals;
  }

  compress(): CsrMatrix {
    const n = this.size;
    const entries = this.count;

    const bucketStart = new Int32Array(n + 1);
    for (let e = 0; e < entries; e++) bucketStart[this.rows[e] + 1]++;
    for (let i = 0; i < n; i++) bucketStart[i + 1] += bucketStart[i];

    const bucketCols = new Int32Array(entries);
    const bucketVals = new Float64Array(entries);
    const cursor = Int32Array.from(bucketStart.subarray(0, n));
    for (let e = 0; e < entries; e++) {
      const slot = cursor[this.rows[e]]++;
      bucketCols[slot] = this.cols[e];
      bucketVals[slot] = this.vals[e];
    }

    // marker[c] holds where column c already landed in the current row, so duplicates
    // merge in one pass without sorting the whole triplet list.
    const marker = new Int32Array(n).fill(-1);
    const colIndex = new Int32Array(entries);
    const values = new Float64Array(entries);
    const rowPtr = new Int32Array(n + 1);
    let out = 0;
    for (let i = 0; i < n; i++) {
      const rowStart = out;
      for (let p = bucketStart[i]; p < bucketStart[i + 1]; p++) {
        const col = bucketCols[p];
        if (marker[col] >= rowStart) {
          values[marker[col]] += bucketVals[p];
        } else {
          marker[col] = out;
          colIndex[out] = col;
          values[out] = bucketVals[p];
          out++;
        }
      }
      sortRowByColumn(colIndex, values, rowStart, out);
      rowPtr[i + 1] = out;
    }

    return new CsrMatrix(n, rowPtr, colIndex.slice(0, out), values.slice(0, out));
  }
}

/** Insertion sort: rows hold one entry per mesh neighbour, so they are a handful long. */
function sortRowByColumn(
  colIndex: Int32Array,
  values: Float64Array,
  start: number,
  end: number,
): void {
  for (let i = start + 1; i < end; i++) {
    const col = colIndex[i];
    const value = values[i];
    let j = i - 1;
    while (j >= start && colIndex[j] > col) {
      colIndex[j + 1] = colIndex[j];
      values[j + 1] = values[j];
      j--;
    }
    colIndex[j + 1] = col;
    values[j + 1] = value;
  }
}

export interface CgOptions {
  /** Relative residual target, ‖r‖/‖b‖. */
  tolerance?: number;
  maxIterations?: number;
  initialGuess?: Float64Array;
}

export interface CgResult {
  x: Float64Array;
  iterations: number;
  /** Final absolute residual ‖b − Ax‖₂. */
  residual: number;
  /** Same residual relative to ‖b‖. */
  relativeResidual: number;
  converged: boolean;
}

export function conjugateGradient(
  matrix: CsrMatrix,
  b: Float64Array,
  options: CgOptions = {},
): CgResult {
  const n = matrix.size;
  const tolerance = options.tolerance ?? 1e-10;
  const maxIterations = options.maxIterations ?? Math.max(1000, n * 2);

  const x = new Float64Array(n);
  if (options.initialGuess && options.initialGuess.length === n) x.set(options.initialGuess);

  const inverseDiagonal = matrix.diagonal();
  for (let i = 0; i < n; i++) {
    const d = inverseDiagonal[i];
    inverseDiagonal[i] = d > 0 ? 1 / d : 1;
  }

  let bNorm = 0;
  for (let i = 0; i < n; i++) bNorm += b[i] * b[i];
  bNorm = Math.sqrt(bNorm);
  const target = tolerance * (bNorm > 0 ? bNorm : 1);

  const r = new Float64Array(n);
  matrix.multiply(x, r);
  for (let i = 0; i < n; i++) r[i] = b[i] - r[i];

  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const ap = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    z[i] = inverseDiagonal[i] * r[i];
    p[i] = z[i];
  }

  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i] * z[i];
  let residual = norm(r);
  let iterations = 0;

  while (residual > target && iterations < maxIterations) {
    matrix.multiply(p, ap);
    let pap = 0;
    for (let i = 0; i < n; i++) pap += p[i] * ap[i];
    if (!(Math.abs(pap) > 0)) break;

    const alpha = rz / pap;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
    }

    let rzNext = 0;
    for (let i = 0; i < n; i++) {
      z[i] = inverseDiagonal[i] * r[i];
      rzNext += r[i] * z[i];
    }
    const beta = rzNext / rz;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    rz = rzNext;

    residual = norm(r);
    iterations++;
    if (!Number.isFinite(residual)) break;
  }

  return {
    x,
    iterations,
    residual,
    relativeResidual: bNorm > 0 ? residual / bNorm : residual,
    converged: Number.isFinite(residual) && residual <= target,
  };
}

function norm(v: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}
