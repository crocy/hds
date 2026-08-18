/**
 * Voxelisation: does the grid actually land inside the part, and does it find the
 * surface it has to hand its heat to?
 */

import { describe, expect, it } from 'vitest';

import { boxMesh, mergeMeshes, modelFromMesh } from '../core/testModels';
import { buildVolumeMesh } from './volume';

/** A 100 mm cube, so a 25 mm cell gives a 4×4×4 grid with nothing left over. */
function cube(size = 0.1) {
  return modelFromMesh(boxMesh([size, size, size]), [{ name: 'block' }]);
}

describe('buildVolumeMesh', () => {
  it('fills a cube and links every shared face', () => {
    const model = cube();
    const volume = buildVolumeMesh(model, 0, { cellSize: 0.025 });

    expect(volume.cellCount).toBe(64);
    // 3 × 4 × 4 × 4 interior faces: one per axis per plane between cells.
    expect(volume.links.length / 2).toBe(3 * 3 * 4 * 4);
    // The surface of a 4×4×4 grid: 6 faces of 16 cells.
    expect(volume.boundaryCell.length).toBe(6 * 16);
    for (const triangle of volume.boundaryTriangle) {
      expect(model.triPart[triangle]).toBe(0);
    }
  });

  it('puts every cell inside the part', () => {
    const model = cube();
    const volume = buildVolumeMesh(model, 0, { cellSize: 0.025 });
    for (let cell = 0; cell < volume.cellCount; cell++) {
      for (let axis = 0; axis < 3; axis++) {
        const v = volume.centres[cell * 3 + axis];
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(0.1);
      }
    }
  });

  it('counts only its own part, not the assembly around it', () => {
    // A box sitting inside a bigger one: voxelising the inner part must not read the
    // outer part's walls as crossings of its own shell.
    const model = modelFromMesh(
      mergeMeshes(boxMesh([0.4, 0.4, 0.4], [0, 0, 0], 0), boxMesh([0.1, 0.1, 0.1], [0.15, 0.15, 0.15], 1)),
      [{ name: 'outer' }, { name: 'inner' }],
    );
    const inner = buildVolumeMesh(model, 1, { cellSize: 0.025 });
    expect(inner.cellCount).toBe(64);
    for (const triangle of inner.boundaryTriangle) expect(model.triPart[triangle]).toBe(1);
  });

  it('hollows out a pocket rather than filling it', () => {
    // The insulation case: a block with a blind pocket a heat source sits in. The
    // pocket must come out empty, or the wool conducts across thin air.
    const wall = mergeMeshes(
      boxMesh([0.3, 0.3, 0.3], [0, 0, 0], 0),
      invert(boxMesh([0.1, 0.1, 0.1], [0.1, 0.1, 0.1], 0)),
    );
    const model = modelFromMesh(wall, [{ name: 'shell' }]);
    const volume = buildVolumeMesh(model, 0, { cellSize: 0.05 });

    // 6×6×6 grid less the 2×2×2 the pocket takes out of the middle.
    expect(volume.cellCount).toBe(6 * 6 * 6 - 2 * 2 * 2);
    for (let cell = 0; cell < volume.cellCount; cell++) {
      const inPocket = [0, 1, 2].every((axis) => {
        const v = volume.centres[cell * 3 + axis];
        return v > 0.1 && v < 0.2;
      });
      expect(inPocket).toBe(false);
    }
  });

  it('coarsens rather than voxelising a corner of the part', () => {
    const model = cube();
    const volume = buildVolumeMesh(model, 0, { cellSize: 0.001, maxCells: 500 });
    expect(volume.coarsened).toBe(true);
    expect(volume.cellCount).toBeLessThanOrEqual(500);
    expect(volume.cellCount).toBeGreaterThan(0);
  });

  it('finds nothing in an open shell, and says so by being empty', () => {
    const open = boxMesh([0.1, 0.1, 0.1]);
    open.indices.splice(0, 6);
    open.partOf.splice(0, 2);
    open.faceOf.splice(0, 2);
    const model = modelFromMesh(open, [{ name: 'open' }]);
    expect(buildVolumeMesh(model, 0, { cellSize: 0.025 }).cellCount).toBe(0);
  });
});

function invert(mesh: ReturnType<typeof boxMesh>) {
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const b = mesh.indices[t * 3 + 1];
    mesh.indices[t * 3 + 1] = mesh.indices[t * 3 + 2];
    mesh.indices[t * 3 + 2] = b;
  }
  return mesh;
}
