/**
 * CSR assembly and conjugate gradient on systems small enough to solve by hand.
 */

import { describe, expect, it } from 'vitest';
import { conjugateGradient, CsrMatrix, SparseBuilder } from './sparse';

/** Dense → CSR, for stating a small test matrix as it reads on paper. */
function csrFrom(dense: number[][]): CsrMatrix {
  const builder = new SparseBuilder(dense.length);
  dense.forEach((row, i) => {
    row.forEach((value, j) => {
      if (value !== 0) builder.add(i, j, value);
    });
  });
  return builder.compress();
}

/** −1, 2, −1 with Dirichlet ends: the classic SPD test problem. */
function laplacian(n: number): CsrMatrix {
  const builder = new SparseBuilder(n);
  for (let i = 0; i < n; i++) {
    builder.add(i, i, 2);
    if (i > 0) builder.add(i, i - 1, -1);
    if (i + 1 < n) builder.add(i, i + 1, -1);
  }
  return builder.compress();
}

describe('SparseBuilder', () => {
  it('sums duplicate entries and sorts each row by column', () => {
    const builder = new SparseBuilder(3);
    builder.add(0, 2, 1);
    builder.add(0, 0, 2);
    builder.add(0, 2, 3);
    builder.add(2, 1, 5);
    const matrix = builder.compress();

    expect(builder.entryCount).toBe(4);
    expect(Array.from(matrix.colIndex.subarray(matrix.rowPtr[0], matrix.rowPtr[1]))).toEqual([
      0, 2,
    ]);
    expect(matrix.get(0, 2)).toBe(4);
    expect(matrix.get(0, 0)).toBe(2);
    expect(matrix.get(2, 1)).toBe(5);
    expect(matrix.get(1, 1)).toBe(0);
    expect(matrix.nnz).toBe(3);
  });

  it('keeps an explicitly added zero, so a reserved diagonal slot survives', () => {
    const builder = new SparseBuilder(2);
    builder.add(0, 0, 0);
    const matrix = builder.compress();
    expect(matrix.nnz).toBe(1);
    expect(Array.from(matrix.diagonal())).toEqual([0, 0]);
  });

  it('grows past its initial capacity', () => {
    const builder = new SparseBuilder(4, 1);
    for (let i = 0; i < 4; i++) builder.add(i, i, i + 1);
    expect(Array.from(builder.compress().diagonal())).toEqual([1, 2, 3, 4]);
  });

  it('rejects entries outside the matrix rather than corrupting a row', () => {
    const builder = new SparseBuilder(2);
    expect(() => builder.add(2, 0, 1)).toThrow(RangeError);
    expect(() => builder.add(0, -1, 1)).toThrow(RangeError);
  });
});

describe('CsrMatrix', () => {
  const matrix = csrFrom([
    [4, 1, 0],
    [1, 3, 1],
    [0, 1, 2],
  ]);

  it('multiplies a vector', () => {
    const y = matrix.multiply(Float64Array.of(1, 2, 3));
    expect(Array.from(y)).toEqual([6, 10, 8]);
  });

  it('reuses a correctly sized output vector', () => {
    const out = new Float64Array(3);
    expect(matrix.multiply(Float64Array.of(1, 1, 1), out)).toBe(out);
    expect(Array.from(out)).toEqual([5, 5, 3]);
  });

  it('reads the diagonal and arbitrary entries', () => {
    expect(Array.from(matrix.diagonal())).toEqual([4, 3, 2]);
    expect(matrix.get(1, 2)).toBe(1);
    expect(matrix.get(2, 0)).toBe(0);
  });

  it('clones the values but shares the structure', () => {
    const copy = matrix.clone();
    copy.values[0] = 99;
    expect(matrix.get(0, 0)).toBe(4);
    expect(copy.rowPtr).toBe(matrix.rowPtr);
  });
});

describe('conjugateGradient', () => {
  it('solves a 2×2 system with a known exact answer', () => {
    // 4x + y = 1, x + 3y = 2  →  x = 1/11, y = 7/11.
    const result = conjugateGradient(
      csrFrom([
        [4, 1],
        [1, 3],
      ]),
      Float64Array.of(1, 2),
      { tolerance: 1e-14 },
    );
    expect(result.converged).toBe(true);
    expect(result.x[0]).toBeCloseTo(1 / 11, 12);
    expect(result.x[1]).toBeCloseTo(7 / 11, 12);
    expect(result.iterations).toBeLessThanOrEqual(2);
  });

  it('solves a 1D Laplacian against its analytic solution', () => {
    // A·x = b with b = (1, 0, …, 0) has x_i = (n − i)/(n + 1): a straight line.
    const n = 20;
    const b = new Float64Array(n);
    b[0] = 1;
    const result = conjugateGradient(laplacian(n), b, { tolerance: 1e-12, maxIterations: 500 });

    expect(result.converged).toBe(true);
    for (let i = 0; i < n; i++) {
      expect(result.x[i]).toBeCloseTo((n - i) / (n + 1), 9);
    }
    expect(result.relativeResidual).toBeLessThan(1e-12);
  });

  it('starts from the supplied guess and stops immediately when it is already right', () => {
    const n = 8;
    const b = new Float64Array(n);
    b[0] = 1;
    const exact = conjugateGradient(laplacian(n), b, { tolerance: 1e-14 });
    const again = conjugateGradient(laplacian(n), b, {
      tolerance: 1e-12,
      initialGuess: exact.x,
    });
    expect(again.iterations).toBe(0);
    expect(again.converged).toBe(true);
  });

  it('reports failure instead of a wrong answer when it runs out of iterations', () => {
    const n = 60;
    const b = new Float64Array(n).fill(1);
    const result = conjugateGradient(laplacian(n), b, { tolerance: 1e-14, maxIterations: 2 });
    expect(result.converged).toBe(false);
    expect(result.iterations).toBe(2);
    expect(result.relativeResidual).toBeGreaterThan(1e-14);
  });

  it('handles a zero right-hand side without dividing by its norm', () => {
    const result = conjugateGradient(laplacian(5), new Float64Array(5), { tolerance: 1e-12 });
    expect(result.converged).toBe(true);
    expect(result.relativeResidual).toBe(0);
    for (const value of result.x) expect(value).toBe(0);
  });

  it('is preconditioned: badly scaled diagonals do not slow it down', () => {
    const n = 30;
    const builder = new SparseBuilder(n);
    for (let i = 0; i < n; i++) builder.add(i, i, 10 ** (i % 6));
    const b = new Float64Array(n).fill(1);
    const result = conjugateGradient(builder.compress(), b, { tolerance: 1e-12 });
    // Jacobi turns a diagonal matrix into the identity: one step.
    expect(result.iterations).toBeLessThanOrEqual(1);
    expect(result.x[5]).toBeCloseTo(1 / 10 ** 5, 12);
  });
});
