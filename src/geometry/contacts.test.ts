import { describe, expect, it } from 'vitest';

import { modelFromMesh, twoStripModel } from '../core/testModels';
import type { ThermalModel, Vec3 } from '../core/types';
import { contactArea, createContact, detectContacts, DEFAULT_CONTACT_TOLERANCE } from './contacts';

interface Mesh {
  positions: number[];
  indices: number[];
  partOf: number[];
  faceOf: number[];
}

/**
 * A closed axis-aligned box whose faces are each split into a `divisions` × `divisions`
 * grid. Two boxes built with different `divisions` meet non-conformally — exactly what a
 * CAD assembly does, since each solid is tessellated on its own.
 */
function subdividedBox(min: Vec3, size: Vec3, divisions: number, partIndex: number): Mesh {
  const mesh: Mesh = { positions: [], indices: [], partOf: [], faceOf: [] };
  const [x0, y0, z0] = min;
  const [sx, sy, sz] = size;
  // origin, then two edge vectors whose cross product points out of the box.
  const faces: Array<[Vec3, Vec3, Vec3]> = [
    [
      [x0, y0, z0],
      [0, sy, 0],
      [sx, 0, 0],
    ],
    [
      [x0, y0, z0 + sz],
      [sx, 0, 0],
      [0, sy, 0],
    ],
    [
      [x0, y0, z0],
      [sx, 0, 0],
      [0, 0, sz],
    ],
    [
      [x0, y0 + sy, z0],
      [0, 0, sz],
      [sx, 0, 0],
    ],
    [
      [x0, y0, z0],
      [0, 0, sz],
      [0, sy, 0],
    ],
    [
      [x0 + sx, y0, z0],
      [0, sy, 0],
      [0, 0, sz],
    ],
  ];

  faces.forEach(([origin, u, v], faceIndex) => {
    const base = mesh.positions.length / 3;
    for (let j = 0; j <= divisions; j++) {
      for (let i = 0; i <= divisions; i++) {
        const s = i / divisions;
        const t = j / divisions;
        mesh.positions.push(
          origin[0] + u[0] * s + v[0] * t,
          origin[1] + u[1] * s + v[1] * t,
          origin[2] + u[2] * s + v[2] * t,
        );
      }
    }
    const at = (i: number, j: number) => base + j * (divisions + 1) + i;
    for (let j = 0; j < divisions; j++) {
      for (let i = 0; i < divisions; i++) {
        mesh.indices.push(at(i, j), at(i + 1, j), at(i + 1, j + 1));
        mesh.indices.push(at(i, j), at(i + 1, j + 1), at(i, j + 1));
        mesh.partOf.push(partIndex, partIndex);
        mesh.faceOf.push(faceIndex, faceIndex);
      }
    }
  });
  return mesh;
}

function mergeAll(...meshes: Mesh[]): Mesh {
  const out: Mesh = { positions: [], indices: [], partOf: [], faceOf: [] };
  for (const mesh of meshes) {
    const base = out.positions.length / 3;
    out.positions.push(...mesh.positions);
    for (const index of mesh.indices) out.indices.push(index + base);
    out.partOf.push(...mesh.partOf);
    out.faceOf.push(...mesh.faceOf);
  }
  return out;
}

/** Lower box 3×3 per face, upper box 4×4, offset so no two vertices line up. */
function stackedBoxes(gap: number): ThermalModel {
  return modelFromMesh(
    mergeAll(
      subdividedBox([0, 0, 0], [0.1, 0.1, 0.1], 3, 0),
      subdividedBox([0.013, 0.017, 0.1 + gap], [0.05, 0.05, 0.05], 4, 1),
    ),
    [{ name: 'lower' }, { name: 'upper' }],
  );
}

function nearestNodeDistanceBetweenParts(model: ThermalModel): number {
  let best = Infinity;
  for (let i = 0; i < model.nodeCount; i++) {
    for (let j = 0; j < model.nodeCount; j++) {
      if (model.nodePart[i] === model.nodePart[j]) continue;
      const distance = Math.hypot(
        model.nodes[i * 3] - model.nodes[j * 3],
        model.nodes[i * 3 + 1] - model.nodes[j * 3 + 1],
        model.nodes[i * 3 + 2] - model.nodes[j * 3 + 2],
      );
      if (distance < best) best = distance;
    }
  }
  return best;
}

describe('detectContacts', () => {
  it('finds the joint between two boxes whose meshes do not line up', () => {
    const model = stackedBoxes(0);

    // The premise of the test: node-to-node pairing has nothing to work with here.
    expect(nearestNodeDistanceBetweenParts(model)).toBeGreaterThan(4 * DEFAULT_CONTACT_TOLERANCE);

    const contacts = detectContacts(model);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].partA).toBe(model.parts[0].id);
    expect(contacts[0].partB).toBe(model.parts[1].id);
    expect(contacts[0].autoDetected).toBe(true);

    // Every node of the smaller box's mating face should have found a path across.
    const upperSide = new Set<number>();
    for (let pair = 0; pair < contacts[0].nodePairs.length / 2; pair++) {
      upperSide.add(contacts[0].nodePairs[pair * 2 + 1]);
    }
    expect(upperSide.size).toBeGreaterThanOrEqual(25);

    const matingArea = 0.05 * 0.05;
    expect(contactArea(contacts[0])).toBeGreaterThan(matingArea * 0.5);
    expect(contactArea(contacts[0])).toBeLessThan(matingArea * 2);
  });

  it('leaves boxes further apart than the tolerance unconnected', () => {
    expect(detectContacts(stackedBoxes(0.002))).toEqual([]);
    expect(detectContacts(stackedBoxes(2 * DEFAULT_CONTACT_TOLERANCE))).toEqual([]);
  });

  it('refuses parts that run alongside each other without facing', () => {
    // Two coplanar strips meeting edge to edge: their surfaces are within tolerance
    // but both point the same way, so neither faces the other.
    const model = twoStripModel();
    expect(detectContacts(model)).toEqual([]);
    // ...and it really is the facing rule that rejects them.
    expect(detectContacts(model, { maxFacingCosine: 1 })).toHaveLength(1);
  });

  it('gives every contact a readable, unique id', () => {
    const contacts = detectContacts(stackedBoxes(0));
    expect(contacts.map((c) => c.id)).toEqual(['contact-lower-upper-1']);
    expect(new Set(contacts.map((c) => c.id)).size).toBe(contacts.length);
  });

  it('honours conductance and tolerance options', () => {
    const contacts = detectContacts(stackedBoxes(0.0008), {
      tolerance: 0.001,
      conductance: 500,
    });
    expect(contacts).toHaveLength(1);
    expect(contacts[0].conductance).toBe(500);
  });
});

describe('createContact', () => {
  it('bonds two node sets by hand across a gap detection would reject', () => {
    const model = stackedBoxes(0.01);
    const lower = [];
    const upper = [];
    for (let node = 0; node < model.nodeCount; node++) {
      if (model.nodePart[node] === 0 && model.nodes[node * 3 + 2] > 0.099) lower.push(node);
      if (model.nodePart[node] === 1 && model.nodes[node * 3 + 2] < 0.111) upper.push(node);
    }
    expect(detectContacts(model)).toEqual([]);

    const contact = createContact(model, lower, upper, { conductance: 1000 });
    expect(contact.autoDetected).toBe(false);
    expect(contact.conductance).toBe(1000);
    expect(contact.partA).toBe(model.parts[0].id);
    expect(contact.partB).toBe(model.parts[1].id);
    expect(contact.nodePairs.length / 2).toBeGreaterThan(0);
    expect(contactArea(contact)).toBeGreaterThan(0);
    for (let pair = 0; pair < contact.nodePairs.length / 2; pair++) {
      expect(model.nodePart[contact.nodePairs[pair * 2]]).toBe(0);
      expect(model.nodePart[contact.nodePairs[pair * 2 + 1]]).toBe(1);
    }
  });

  it('rejects a node set that is empty or on a single part', () => {
    const model = stackedBoxes(0);
    expect(() => createContact(model, [], [1])).toThrow(/non-empty/);
    expect(() => createContact(model, [0], [1])).toThrow(/both node sets/);
  });
});
