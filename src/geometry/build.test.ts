import { describe, expect, it } from 'vitest';
import { boxMesh, mergeMeshes, stripMesh } from '../core/testModels';
import { buildThermalModel, DEFAULT_SHEET_THICKNESS } from './build';
import type { ImportedMesh } from './importers';
import { buildEdgeAdjacency, connectedComponents } from './topology';
import type { LengthUnit } from '../core/units';

type RawMesh = ReturnType<typeof boxMesh>;

interface ImportedOverrides {
  partNames?: string[];
  units?: LengthUnit;
  derivePartsFromComponents?: boolean;
  withFaces?: boolean;
}

function imported(mesh: RawMesh, overrides: ImportedOverrides = {}): ImportedMesh {
  return {
    positions: Float64Array.from(mesh.positions),
    indices: Uint32Array.from(mesh.indices),
    triPart: Uint32Array.from(mesh.partOf),
    triFace: overrides.withFaces ? Uint32Array.from(mesh.faceOf) : null,
    partNames: overrides.partNames ?? ['body'],
    units: overrides.units ?? 'm',
    derivePartsFromComponents: overrides.derivePartsFromComponents ?? false,
  };
}

describe('vertex welding', () => {
  it('collapses the box tessellator’s duplicated corners', () => {
    const model = buildThermalModel(imported(boxMesh([1, 2, 3])));

    // 6 quads emitted as 24 loose corners collapse onto the box's 8.
    expect(model.nodeCount).toBe(8);
    expect(model.triCount).toBe(12);
  });

  it('leaves the welded shell closed and edge-connected', () => {
    const model = buildThermalModel(imported(boxMesh([1, 2, 3])));
    const adjacency = buildEdgeAdjacency(model.tris, model.nodeCount);

    expect([...adjacency.edgeUseCount].every((count) => count === 2)).toBe(true);
    expect(connectedComponents(model.tris, model.nodeCount).count).toBe(1);
  });

  it('never welds across parts, so contacts stay explicit', () => {
    const coincident = mergeMeshes(
      boxMesh([1, 1, 1], [0, 0, 0], 0),
      boxMesh([1, 1, 1], [0, 0, 0], 1),
    );
    const model = buildThermalModel(imported(coincident, { partNames: ['a', 'b'] }));

    expect(model.parts).toHaveLength(2);
    expect(model.nodeCount).toBe(16);
    expect(connectedComponents(model.tris, model.nodeCount).count).toBe(2);
  });

  it('welds vertices that differ by less than the tolerance', () => {
    const mesh = boxMesh([1, 1, 1]);
    const nudge = 1e-9; // bbox diagonal is 1.73 m, so the tolerance is 1.7e-6 m
    for (let i = 0; i < mesh.positions.length; i += 3) mesh.positions[i] += nudge * (i % 7);

    expect(buildThermalModel(imported(mesh)).nodeCount).toBe(8);
  });
});

describe('areas and normals', () => {
  it('gives a unit square strip area 1 and a +Z normal', () => {
    const model = buildThermalModel(imported(stripMesh(1, 1, 4, 4)));

    const total = [...model.triArea].reduce((sum, area) => sum + area, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(model.parts[0].surfaceArea).toBeCloseTo(1, 6);
    for (let t = 0; t < model.triCount; t++) {
      expect(model.triNormal[t * 3]).toBeCloseTo(0, 6);
      expect(model.triNormal[t * 3 + 1]).toBeCloseTo(0, 6);
      expect(model.triNormal[t * 3 + 2]).toBeCloseTo(1, 6);
    }
  });

  it('splits each triangle’s area equally over its three nodes', () => {
    const model = buildThermalModel(imported(stripMesh(1, 1, 4, 4)));
    const nodeTotal = [...model.nodeArea].reduce((sum, area) => sum + area, 0);
    expect(nodeTotal).toBeCloseTo(1, 6);
  });
});

describe('volume and body type', () => {
  it('recovers the box volume from the divergence theorem', () => {
    const model = buildThermalModel(imported(boxMesh([2, 3, 4])));
    expect(model.parts[0].volume).toBeCloseTo(2 * 3 * 4, 6);
  });

  it('reports zero volume for an open shell', () => {
    const model = buildThermalModel(imported(stripMesh(1, 1, 4, 4)));
    expect(model.parts[0].volume).toBe(0);
    expect(model.parts[0].thinnessRatio).toBe(0);
    expect(model.parts[0].bodyType).toBe('sheet');
  });

  it('guesses lump for a chunky solid and sheet for a thin one', () => {
    const chunky = buildThermalModel(imported(boxMesh([1, 1, 1])));
    expect(chunky.parts[0].thinnessRatio).toBeGreaterThan(0.5);
    expect(chunky.parts[0].bodyType).toBe('lump');

    const thin = buildThermalModel(imported(boxMesh([1, 1, 0.005])));
    expect(thin.parts[0].thinnessRatio).toBeLessThan(0.3);
    expect(thin.parts[0].bodyType).toBe('sheet');
  });

  it('reads the sheet thickness off a closed solid instead of guessing', () => {
    // A 1×1 m plate of 2 mm sheet, tessellated as the solid it is: both faces plus the
    // edge bands. 2·volume/surfaceArea recovers the 2 mm the drawing would quote.
    // The edge bands are counted in the area but add almost nothing to the volume, so
    // the reading sits a fraction of a percent low — 1.992 mm here, 0.99 mm for the
    // TBTE parts drawn from 1 mm sheet.
    const model = buildThermalModel(imported(boxMesh([1, 1, 0.002])));
    expect(model.parts[0].thickness).toBeCloseTo(0.002, 4);
    expect(model.parts[0].thickness).toBeLessThan(0.002);
  });

  it('falls back to the default thickness for an open shell, and honours an override', () => {
    const open = buildThermalModel(imported(stripMesh(1, 1, 4, 4)));
    expect(open.parts[0].volume).toBe(0);
    expect(open.parts[0].thickness).toBe(DEFAULT_SHEET_THICKNESS);

    const overridden = buildThermalModel(imported(boxMesh([1, 1, 0.002])), {
      defaultThickness: 0.005,
    });
    expect(overridden.parts[0].thickness).toBe(0.005);
  });

  it('never guesses insulator', () => {
    const model = buildThermalModel(
      imported(
        mergeMeshes(boxMesh([1, 1, 1], [0, 0, 0], 0), stripMesh(1, 1, 2, 2, 1, 0, [4, 0, 0])),
        {
          partNames: ['solid', 'sheet'],
        },
      ),
    );
    expect(model.parts.map((part) => part.bodyType)).toEqual(['lump', 'sheet']);
  });
});

describe('part ranges', () => {
  it('gives every part a contiguous triangle and node range', () => {
    const mesh = mergeMeshes(
      boxMesh([1, 1, 1], [0, 0, 0], 0),
      stripMesh(1, 1, 3, 3, 1, 0, [4, 0, 0]),
      boxMesh([2, 2, 2], [0, 8, 0], 2),
    );
    const model = buildThermalModel(imported(mesh, { partNames: ['a', 'b', 'c'] }));

    expect(model.parts).toHaveLength(3);
    let triCursor = 0;
    let nodeCursor = 0;
    for (const part of model.parts) {
      expect(part.triRange[0]).toBe(triCursor);
      expect(part.nodeRange[0]).toBe(nodeCursor);
      triCursor = part.triRange[1];
      nodeCursor = part.nodeRange[1];
      for (let t = part.triRange[0]; t < part.triRange[1]; t++) {
        expect(model.triPart[t]).toBe(model.parts.indexOf(part));
      }
      for (let n = part.nodeRange[0]; n < part.nodeRange[1]; n++) {
        expect(model.nodePart[n]).toBe(model.parts.indexOf(part));
      }
    }
    expect(triCursor).toBe(model.triCount);
    expect(nodeCursor).toBe(model.nodeCount);
  });

  it('derives parts from connected components when the format has none', () => {
    const mesh = mergeMeshes(boxMesh([1, 1, 1]), boxMesh([1, 1, 1], [5, 0, 0]));
    const model = buildThermalModel(
      imported(mesh, { partNames: ['scan'], derivePartsFromComponents: true }),
    );

    expect(model.parts.map((part) => part.name)).toEqual(['scan 1', 'scan 2']);
    expect(model.nodeCount).toBe(16);
  });
});

describe('face regions', () => {
  it('keeps source face ids when the importer supplied them', () => {
    const model = buildThermalModel(imported(boxMesh([1, 2, 3]), { withFaces: true }));
    expect(new Set(model.triFace).size).toBe(6);
  });

  it('makes face ids unique across parts', () => {
    const mesh = mergeMeshes(boxMesh([1, 1, 1], [0, 0, 0], 0), boxMesh([1, 1, 1], [5, 0, 0], 1));
    const model = buildThermalModel(imported(mesh, { partNames: ['a', 'b'], withFaces: true }));
    expect(new Set(model.triFace).size).toBe(12);
  });

  it('falls back to dihedral regions when it did not', () => {
    const model = buildThermalModel(imported(boxMesh([1, 2, 3])));
    expect(new Set(model.triFace).size).toBe(6);
    expect(model.featureEdges).toHaveLength(12);
  });
});

describe('units', () => {
  it('converts the model to metres on the way in', () => {
    const model = buildThermalModel(imported(boxMesh([1000, 2000, 3000]), { units: 'mm' }));

    expect(model.sourceUnits).toBe('mm');
    expect(model.bbox.max).toEqual([1, 2, 3]);
    expect(model.parts[0].volume).toBeCloseTo(6, 6);
  });
});
