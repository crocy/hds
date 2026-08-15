/* Throwaway visual check for src/viewer — not part of the app. */
import { modelFromMesh } from '@/core/testModels';
import { ThermalScene } from '@/viewer';
import type { BoundaryCondition, Scenario, ThermalModel } from '@/core/types';
import { createDefaultScenario } from '@/core/defaults';

function boxShell(size: [number, number, number], divisions = 14) {
  const positions: number[] = [];
  const indices: number[] = [];
  const partOf: number[] = [];
  const faceOf: number[] = [];
  const axes: Array<[number, number, number]> = [
    [0, 1, 2],
    [1, 2, 0],
    [2, 0, 1],
  ];
  let face = 0;
  for (const [u, v, w] of axes) {
    for (const side of [0, 1]) {
      const base = positions.length / 3;
      for (let j = 0; j <= divisions; j++) {
        for (let i = 0; i <= divisions; i++) {
          const p = [0, 0, 0];
          p[u] = (i / divisions - 0.5) * size[u];
          p[v] = (j / divisions - 0.5) * size[v];
          p[w] = (side - 0.5) * size[w];
          positions.push(p[0], p[1], p[2]);
        }
      }
      for (let j = 0; j < divisions; j++) {
        for (let i = 0; i < divisions; i++) {
          const a = base + j * (divisions + 1) + i;
          const b = a + 1;
          const c = a + divisions + 2;
          const d = a + divisions + 1;
          if (side === 0) indices.push(a, b, c, a, c, d);
          else indices.push(a, c, b, a, d, c);
          partOf.push(face < 4 ? 0 : 1, face < 4 ? 0 : 1);
          faceOf.push(face, face);
        }
      }
      face++;
    }
  }
  return { positions, indices, partOf, faceOf };
}

function rimField(model: ThermalModel): Float32Array {
  const out = new Float32Array(model.nodeCount);
  const top = model.bbox.max[2];
  for (let n = 0; n < model.nodeCount; n++) {
    const z = model.nodes[n * 3 + 2];
    const r = Math.hypot(model.nodes[n * 3], model.nodes[n * 3 + 1]);
    const distance = Math.hypot(top - z, Math.max(0, 0.06 - r));
    out[n] = 293.15 + 180 * Math.exp(-distance / 0.04);
  }
  return out;
}

const model = modelFromMesh(boxShell([0.2, 0.16, 0.12]), [{ name: 'shell' }, { name: 'lid' }]);
const scene = new ThermalScene();
const container = document.getElementById('view');
if (!container) throw new Error('#view missing');
scene.mount(container);
scene.setModel(model);

const params = new URLSearchParams(location.search);
const fixed: BoundaryCondition = {
  id: 'bc-1',
  kind: 'fixedTemp',
  target: { type: 'face', partId: model.parts[0].id, faceId: 1 },
  value: 473,
  enabled: true,
};
const scenario: Scenario = { ...createDefaultScenario(), boundaryConditions: [fixed] };
scene.setScenario(scenario);
scene.setTemperatures(rimField(model), scenario.colorScale, scenario.ambient);

if (params.has('wire')) scene.setWireframe(true);
if (params.has('overlays')) {
  scene.setOverlayVisible('fixedTemp', true);
  scene.setOverlayVisible('featureEdges', true);
}
if (params.has('section')) {
  scene.setSectionEnabled(true);
  scene.setSectionAxis('y');
  scene.setSectionOffset(0.02);
}
if (params.has('ghost')) {
  scene.setPartOverrides({ [model.parts[1].id]: { opacity: 0.25 } });
}

if (params.has('field')) {
  const extent = scene.getSectionExtent();
  const width = 96;
  const height = 96;
  const values = new Float32Array(width * height);
  const mask = new Uint8Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const u = extent.uMin + ((i + 0.5) / width) * (extent.uMax - extent.uMin);
      const v = extent.vMin + ((j + 0.5) / height) * (extent.vMax - extent.vMin);
      const cell = j * width + i;
      const inside = Math.abs(u) < 0.07 && Math.abs(v) < 0.045;
      mask[cell] = inside ? 1 : 0;
      values[cell] = inside ? 293.15 + 180 * Math.exp(-Math.hypot(u, v - 0.05) / 0.05) : Number.NaN;
    }
  }
  scene.setSectionField(
    { width, height, ...extent, values, mask, contours: [] },
    { map: 'inferno', min: 293.15, max: 473.15 },
  );
}

if (params.has('always')) {
  const spin = () => {
    scene.invalidate();
    requestAnimationFrame(spin);
  };
  spin();
}
