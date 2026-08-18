/**
 * The volumetric benchmark: does a filled part actually drop `t/(k·A)` across itself?
 *
 * This is the check that decides whether `solid` means anything. A shell part conducts
 * along its skin, so a thick low-k body — insulation, above all — short-circuits its own
 * thickness and reports far more heat than it passes. Filling it has to reproduce the
 * textbook slab, and has to keep doing so as the grid changes, because a series of
 * cells sums to the same resistance whatever the count.
 */

import { describe, expect, it } from 'vitest';

import type { Scenario } from '../core/types';
import { DEFAULT_SOLVER_SETTINGS } from '../core/types';
import { modelFromMesh } from '../core/testModels';
import { buildVolumeMesh } from '../geometry/volume';
import { solveShell } from './solve';

const AMBIENT = 300;
const K_SS304 = 14.9;

/**
 * A box whose faces are subdivided n×n, so a face target names a whole surface rather
 * than its four corners. `boxMesh` gives two triangles per face, which pins a face by
 * its corners alone and measures spreading resistance instead of conduction.
 */
function subdividedBox(size: number, n: number) {
  const positions: number[] = [];
  const indices: number[] = [];
  const partOf: number[] = [];
  const faceOf: number[] = [];
  const faces: Array<{ origin: [number, number, number]; u: [number, number, number]; v: [number, number, number] }> = [
    { origin: [0, 0, 0], u: [0, size, 0], v: [size, 0, 0] }, // −Z
    { origin: [0, 0, size], u: [size, 0, 0], v: [0, size, 0] }, // +Z
    { origin: [0, 0, 0], u: [size, 0, 0], v: [0, 0, size] }, // −Y
    { origin: [0, size, 0], u: [0, 0, size], v: [size, 0, 0] }, // +Y
    { origin: [0, 0, 0], u: [0, 0, size], v: [0, size, 0] }, // −X
    { origin: [size, 0, 0], u: [0, size, 0], v: [0, 0, size] }, // +X
  ];

  faces.forEach((face, faceIndex) => {
    const base = positions.length / 3;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        for (let axis = 0; axis < 3; axis++) {
          positions.push(face.origin[axis] + (face.u[axis] * i) / n + (face.v[axis] * j) / n);
        }
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = base + j * (n + 1) + i;
        const b = a + 1;
        const c = a + (n + 1) + 1;
        const d = a + (n + 1);
        indices.push(a, b, c, a, c, d);
        partOf.push(0, 0);
        faceOf.push(faceIndex, faceIndex);
      }
    }
  });
  return { positions, indices, partOf, faceOf };
}

/**
 * Hot face pinned, far face cooled by a known film, everything else adiabatic.
 *
 * Two resistances in series and nothing else: `L/(k·A)` through the block and
 * `1/(h·A)` off its far face. A film alone would pass `h·A·ΔT`, so the gap between
 * that and the answer is exactly the block's own resistance — which is the quantity a
 * shell model of a thick part loses.
 */
function slabScenario(hot: number, film: number): Scenario {
  return {
    ambient: AMBIENT,
    gravity: [0, 0, -1],
    partOverrides: { 'part-0': { bodyType: 'solid', finishId: 'no-radiation' } },
    boundaryConditions: [
      // Order matters: the part-wide zero lands first, then the far face overrides it.
      { id: 'adiabatic', kind: 'convection', target: { type: 'part', partId: 'part-0' }, h: 0, enabled: true },
      { id: 'film', kind: 'convection', target: { type: 'face', partId: 'part-0', faceId: 1 }, h: film, enabled: true },
      {
        id: 'hot',
        kind: 'fixedTemp',
        target: { type: 'face', partId: 'part-0', faceId: 0 },
        value: hot,
        enabled: true,
      },
    ],
    contacts: [],
    cavities: [],
    colorScale: { mode: 'auto', min: 0, max: 0, map: 'inferno' },
    solver: { ...DEFAULT_SOLVER_SETTINGS },
  };
}

describe('volumetric slab benchmark', () => {
  const size = 0.1;
  const hot = 400;
  const film = 50;
  const area = size * size;
  const blockResistance = size / (K_SS304 * area);
  const filmResistance = 1 / (film * area);
  const expectedWatts = (hot - AMBIENT) / (blockResistance + filmResistance);
  /** What the same model would pass if the block offered no resistance at all. */
  const shortCircuitWatts = film * area * (hot - AMBIENT);

  /** A solid part's thickness sets nothing but its grid: four cells across it. */
  const solveSlab = (n: number, cellSize = size / 8) => {
    const model = modelFromMesh(subdividedBox(size, n), [{ name: 'block' }]);
    const scenario = slabScenario(hot, film);
    scenario.partOverrides['part-0'] = {
      ...scenario.partOverrides['part-0'],
      thickness: cellSize * 4,
    };
    return { model, result: solveShell(model, scenario) };
  };

  it('drops the analytic resistance of the block across it', () => {
    const { result } = solveSlab(16);
    const watts = result.balance.lostByConvection;
    expect(watts / expectedWatts).toBeCloseTo(1, 2);
    // ...and nowhere near what a block with no resistance would pass, which is what a
    // shell model of a thick part reports: it conducts along the skin instead.
    expect(watts).toBeLessThan(shortCircuitWatts * 0.8);
    expect(result.warnings.join('\n')).not.toContain('Energy balance');
  });

  it('reports the same watts however fine the grid is', () => {
    // The series sums to the same t/(k·A) at any cell count, and the node-to-cell link
    // carries the half cell at each end, so no resolution is privileged. A scheme that
    // put the boundary at the first cell *centre* instead drifts by 7 % over this range.
    for (const cellSize of [size / 4, size / 8, size / 16]) {
      const { result } = solveSlab(16, cellSize);
      expect(result.balance.lostByConvection / expectedWatts).toBeCloseTo(1, 1);
    }
  });

  it('drops the drop across the block, not along its skin', () => {
    const { model, result } = solveSlab(16);
    const watts = result.balance.lostByConvection;
    const farFace = hot - watts * blockResistance;
    let sum = 0;
    let checked = 0;
    for (let node = 0; node < model.nodeCount; node++) {
      if (Math.abs(model.nodes[node * 3 + 2] - size) > 1e-6) continue;
      sum += result.temperature[node];
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    // The far face averages the 1D answer to within a kelvin over a 100 K drop. Node
    // by node it varies a few degrees — the corners sit against the staircased side
    // walls — which is discretisation, not a path along the skin.
    expect(sum / checked).toBeCloseTo(farFace, 0);
  });

  it('fills the block with cells rather than leaving it hollow', () => {
    const model = modelFromMesh(subdividedBox(size, 8), [{ name: 'block' }]);
    const volume = buildVolumeMesh(model, 0, { cellSize: size / 8 });
    expect(volume.cellCount).toBe(8 * 8 * 8);
  });

  it('falls back to the shell rather than disconnecting a part it cannot fill', () => {
    // An open shell has no interior. Conducting it as a sheet is wrong for a thick
    // body and still far better than a part whose heat has nowhere to go.
    // Drop the +X face, leaving the two the boundary conditions name intact.
    const mesh = subdividedBox(size, 4);
    mesh.indices.length -= 3 * 2 * 4 * 4;
    mesh.partOf.length -= 2 * 4 * 4;
    mesh.faceOf.length -= 2 * 4 * 4;
    const model = modelFromMesh(mesh, [{ name: 'open' }]);
    const result = solveShell(model, slabScenario(hot, film));
    expect(result.warnings.join('\n')).toContain('no interior could be filled');
    // Falling back has to leave a sound field behind, not a corrupted one. It cannot
    // leave a *connected* one here: these faces are joined only through the interior,
    // which is exactly what an open shell does not have.
    expect(result.warnings.join('\n')).not.toContain('Energy balance');
    expect(Number.isFinite(result.maxTemp)).toBe(true);
    expect(result.maxTemp).toBeCloseTo(hot, 6);
  });
});

