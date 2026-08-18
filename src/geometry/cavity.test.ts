import { describe, expect, it } from 'vitest';

import { boxMesh, mergeMeshes, modelFromMesh } from '../core/testModels';
import type { ThermalModel, Vec3 } from '../core/types';
import {
  assignTriangleCavity,
  cavityDefaults,
  detectCavities,
  MAX_CAVITY_ID,
  refreshCavityCounts,
  setCavityCondition,
} from './cavity';

type Mesh = ReturnType<typeof boxMesh>;

/** Flips one triangle's winding, which inverts its normal — a facet whose vote reads backwards. */
function invertTriangle(mesh: Mesh, triangle: number): Mesh {
  const b = mesh.indices[triangle * 3 + 1];
  mesh.indices[triangle * 3 + 1] = mesh.indices[triangle * 3 + 2];
  mesh.indices[triangle * 3 + 2] = b;
  return mesh;
}

/** Turns a box shell inside out, so its normals point away from the material around it. */
function invertWinding(mesh: Mesh): Mesh {
  for (let t = 0; t < mesh.indices.length / 3; t++) invertTriangle(mesh, t);
  return mesh;
}

/** An inner box floating inside an outer one: the inner shell's outside is the cavity. */
function nestedBoxes(): Mesh {
  return mergeMeshes(
    boxMesh([0.2, 0.2, 0.2], [0, 0, 0], 0),
    boxMesh([0.06, 0.06, 0.06], [0.07, 0.07, 0.07], 1),
  );
}

/** boxMesh emits its faces in the order −Z, +Z, −Y, +Y, −X, +X, two triangles each. */
const PLUS_Z_TRIANGLES = [2, 3];

function dropTriangles(mesh: Mesh, triangles: number[]): Mesh {
  for (const t of [...triangles].sort((x, y) => y - x)) {
    mesh.indices.splice(t * 3, 3);
    mesh.partOf.splice(t, 1);
    mesh.faceOf.splice(t, 1);
  }
  return mesh;
}

function model(mesh: Mesh): ThermalModel {
  return modelFromMesh(mesh, [{ name: 'outer' }, { name: 'inner' }]);
}

function trianglesOfCavity(built: ThermalModel, id: number): number[] {
  const triangles: number[] = [];
  for (let t = 0; t < built.triCount; t++) if (built.triCavity[t] === id) triangles.push(t);
  return triangles;
}

describe('detectCavities', () => {
  it('finds the enclosed volume around a box inside a box', () => {
    const built = model(nestedBoxes());
    const result = detectCavities(built);

    expect(result.cavities).toHaveLength(1);
    expect(result.cavities[0].id).toBe(1);
    expect(result.cavities[0].condition).toBe('stillAir');
    expect(result.cavities[0].triCount).toBe(12);
    // Exactly the inner shell: the outer box still sees ambient.
    expect(trianglesOfCavity(built, 1)).toEqual(
      Array.from({ length: 12 }, (_, i) => built.triCount - 12 + i),
    );
  });

  it('joins the two walls of one pocket into a single cavity', () => {
    // The housing case: a sheet-metal shell with a body floating inside it. The two
    // surfaces bound the same trapped air but share no edge, so grouping by mesh
    // adjacency alone gives each its own cavity — and a cavity walled by one part
    // equilibrates with that wall and carries no heat between the two.
    const shell = mergeMeshes(
      boxMesh([0.2, 0.2, 0.2], [0, 0, 0], 0),
      invertWinding(boxMesh([0.18, 0.18, 0.18], [0.01, 0.01, 0.01], 0)),
    );
    const built = modelFromMesh(mergeMeshes(shell, boxMesh([0.06, 0.06, 0.06], [0.07, 0.07, 0.07], 1)), [
      { name: 'shell' },
      { name: 'block' },
    ]);
    const result = detectCavities(built);

    expect(result.cavities).toHaveLength(1);
    expect(result.cavities[0].triCount).toBe(24);
    const walls = new Set(trianglesOfCavity(built, 1).map((t) => built.triPart[t]));
    expect([...walls].sort()).toEqual([0, 1]);
  });

  it('keeps two pockets that cannot see each other apart', () => {
    // Merging is by line of sight, not by "everything enclosed is one volume": two
    // sealed shells side by side are two pockets and have to stay two.
    const shellAt = (x: number) =>
      mergeMeshes(
        boxMesh([0.2, 0.2, 0.2], [x, 0, 0], 0),
        invertWinding(boxMesh([0.18, 0.18, 0.18], [x + 0.01, 0.01, 0.01], 0)),
      );
    const built = modelFromMesh(mergeMeshes(shellAt(0), shellAt(0.5)), [{ name: 'shells' }]);
    const result = detectCavities(built);

    expect(result.cavities).toHaveLength(2);
    expect(result.cavities.map((cavity) => cavity.triCount)).toEqual([12, 12]);
  });

  it('leaves a lone box entirely open to ambient', () => {
    const built = modelFromMesh(boxMesh([0.2, 0.2, 0.2]), [{ name: 'box' }]);
    const result = detectCavities(built);
    expect(result.cavities).toEqual([]);
    expect(Array.from(result.triCavity)).toEqual(new Array(built.triCount).fill(0));
  });

  it('discards a single misclassified facet instead of promoting it to a cavity', () => {
    // One inverted facet on an otherwise open box: its ray fan reports an odd
    // crossing count, which is exactly the noise that produced 77 cavities.
    const mesh = invertTriangle(boxMesh([0.2, 0.2, 0.2]), 0);
    const built = modelFromMesh(mesh, [{ name: 'box' }]);

    expect(detectCavities(built, { cleanupPasses: 0, minTriangles: 1 }).cavities).toHaveLength(1);
    expect(detectCavities(built).cavities).toEqual([]);
  });

  it('sees the inner wall of a hollow sheet solid, which ray parity reads as open air', () => {
    // The bug this scheme exists for: a sheet-metal box is a solid, so its tessellation
    // carries an inner surface as well as an outer one. A ray fired inward from that
    // inner surface crosses the far wall twice and reads even — "open air" — while the
    // surface is in fact sealed inside the box.
    const wall = mergeMeshes(
      boxMesh([0.2, 0.2, 0.2], [0, 0, 0], 0),
      invertWinding(boxMesh([0.18, 0.18, 0.18], [0.01, 0.01, 0.01], 0)),
    );
    const built = modelFromMesh(wall, [{ name: 'hollow' }]);
    const result = detectCavities(built);

    expect(result.cavities).toHaveLength(1);
    expect(result.cavities[0].triCount).toBe(12);
    // Exactly the inner shell, and it sees no sky at all.
    expect(trianglesOfCavity(built, 1)).toEqual(
      Array.from({ length: 12 }, (_, i) => built.triCount - 12 + i),
    );
    for (let t = 0; t < 12; t++) expect(result.openSkyFraction[t]).toBe(1);
    for (let t = 12; t < 24; t++) expect(result.openSkyFraction[t]).toBe(0);
  });

  it('fills a pinhole so one cavity does not come out perforated', () => {
    // An aperture in the enclosure: the two facets of the inner box that look straight
    // out of it do see the sky, and dropping them would perforate an otherwise sealed
    // cavity wall.
    const openTop = dropTriangles(boxMesh([0.2, 0.2, 0.2], [0, 0, 0], 0), PLUS_Z_TRIANGLES);
    const built = model(mergeMeshes(openTop, boxMesh([0.06, 0.06, 0.06], [0.07, 0.07, 0.07], 1)));

    const raw = detectCavities(built, { cleanupPasses: 0, minTriangles: 1 });
    expect(raw.cavities[0].triCount).toBe(10);

    const cleaned = detectCavities(built);
    expect(cleaned.cavities).toHaveLength(1);
    expect(cleaned.cavities[0].triCount).toBe(12);
  });

  it('keeps a group below minTriangles when it carries enough area', () => {
    const built = model(nestedBoxes());
    expect(detectCavities(built, { minTriangles: 20, minArea: 1 }).cavities).toEqual([]);
    expect(detectCavities(built, { minTriangles: 20, minArea: 1e-6 }).cavities).toHaveLength(1);
  });

  it('starts every cavity in the requested condition', () => {
    const built = model(nestedBoxes());
    const result = detectCavities(built, { condition: 'adiabatic' });
    expect(result.cavities[0].h).toBe(cavityDefaults('adiabatic').h);
    expect(setCavityCondition(result.cavities[0], 'stillAir').h).toBe(cavityDefaults('stillAir').h);
  });

  it('shares the last id rather than wrapping past MAX_CAVITY_ID', () => {
    const meshes: Mesh[] = [];
    const cavityCount = MAX_CAVITY_ID + 5;
    for (let i = 0; i < cavityCount; i++) {
      const origin: Vec3 = [i * 0.5, 0, 0];
      meshes.push(boxMesh([0.2, 0.2, 0.2], origin, i * 2));
      meshes.push(boxMesh([0.06, 0.06, 0.06], [origin[0] + 0.07, 0.07, 0.07], i * 2 + 1));
    }
    const built = modelFromMesh(mergeMeshes(...meshes));

    const result = detectCavities(built, { rayCount: 3 });
    expect(result.cavities).toHaveLength(MAX_CAVITY_ID);
    expect(result.cavities[MAX_CAVITY_ID - 1].name).toMatch(/overflow/);
    // The overflow cavity carries the groups that did not get an id of their own.
    expect(result.cavities[MAX_CAVITY_ID - 1].triCount).toBe(12 * 6);
    let inCavity = 0;
    for (let t = 0; t < built.triCount; t++) {
      expect(result.triCavity[t]).toBeLessThanOrEqual(MAX_CAVITY_ID);
      if (result.triCavity[t] > 0) inCavity++;
    }
    expect(inCavity).toBe(12 * cavityCount);
  });
});

describe('manual cavity edits', () => {
  it('moves a triangle between cavities and open air', () => {
    const built = model(nestedBoxes());
    const { cavities } = detectCavities(built);
    const triangle = trianglesOfCavity(built, 1)[0];

    assignTriangleCavity(built, cavities, triangle, 0);
    expect(built.triCavity[triangle]).toBe(0);
    expect(cavities[0].triCount).toBe(11);

    assignTriangleCavity(built, cavities, triangle, 1);
    expect(cavities[0].triCount).toBe(12);
    expect(() => assignTriangleCavity(built, cavities, triangle, 9)).toThrow(/no cavity/);
    expect(() => assignTriangleCavity(built, cavities, built.triCount, 1)).toThrow(/outside/);
  });

  it('recounts from triCavity', () => {
    const built = model(nestedBoxes());
    const { cavities } = detectCavities(built);
    built.triCavity.fill(0);
    refreshCavityCounts(built, cavities);
    expect(cavities[0].triCount).toBe(0);
  });
});
