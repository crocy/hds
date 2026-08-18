import { describe, expect, it } from 'vitest';
import type { Bounds, Target, Vec3 } from '@/core/types';
import { twoStripModel } from '@/core/testModels';
import {
  DEFAULT_FOV,
  MAX_POLAR,
  MIN_POLAR,
  boundsCenter,
  boundsDiagonal,
  frameBounds,
  orbitBasis,
  orbitPosition,
  panView,
  rotateView,
  ThermalScene,
  triangleGroups,
  zoomLimitsFor,
  zoomView,
  type CameraView,
} from './scene';

const view: CameraView = { theta: 0.7, phi: 1.1, radius: 2.5, target: [0.1, -0.2, 0.3] };

const unitBox: Bounds = { min: [-1, -1, -1], max: [1, 1, 1] };

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

describe('boundsCenter / boundsDiagonal', () => {
  it('measures the box', () => {
    expect(boundsCenter({ min: [0, 0, 0], max: [2, 4, 6] })).toEqual([1, 2, 3]);
    expect(boundsDiagonal({ min: [0, 0, 0], max: [3, 4, 0] })).toBeCloseTo(5, 12);
  });

  it('falls back to 1 for a degenerate or empty box', () => {
    expect(boundsDiagonal({ min: [1, 1, 1], max: [1, 1, 1] })).toBe(1);
    expect(boundsDiagonal({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -1, -1] })).toBe(
      1,
    );
  });
});

describe('orbitPosition', () => {
  it('is the target plus a Z-up spherical offset', () => {
    expect(orbitPosition({ theta: 0, phi: Math.PI / 2, radius: 2, target: [1, 2, 3] })).toEqual([
      3, 2, 3,
    ]);
    const overhead = orbitPosition({ theta: 1.3, phi: 1e-9, radius: 2, target: [1, 2, 3] });
    expect(overhead[2]).toBeCloseTo(5, 6);
  });

  it('keeps the camera at `radius` from the target', () => {
    const position = orbitPosition(view);
    const distance = Math.hypot(
      position[0] - view.target[0],
      position[1] - view.target[1],
      position[2] - view.target[2],
    );
    expect(distance).toBeCloseTo(view.radius, 12);
  });
});

describe('orbitBasis', () => {
  it('is orthonormal and right-handed with the view direction', () => {
    const { right, up } = orbitBasis(view);
    expect(Math.hypot(...right)).toBeCloseTo(1, 12);
    expect(Math.hypot(...up)).toBeCloseTo(1, 12);
    expect(dot(right, up)).toBeCloseTo(0, 12);

    const position = orbitPosition(view);
    const offset = [
      position[0] - view.target[0],
      position[1] - view.target[1],
      position[2] - view.target[2],
    ].map((v) => v / view.radius);
    expect(dot(right, offset)).toBeCloseTo(0, 12);
    expect(dot(up, offset)).toBeCloseTo(0, 12);
    const handed = cross(right, up);
    for (let k = 0; k < 3; k++) expect(handed[k]).toBeCloseTo(offset[k], 12);
  });
});

describe('rotateView', () => {
  it('drags the model with the pointer', () => {
    const rotated = rotateView(view, 10, 0);
    expect(rotated.theta).toBeLessThan(view.theta);
    expect(rotated.phi).toBe(view.phi);
    expect(rotated.radius).toBe(view.radius);
    expect(rotated.target).toEqual(view.target);
  });

  it('clamps the polar angle short of both poles', () => {
    expect(rotateView(view, 0, -100000).phi).toBe(MAX_POLAR);
    expect(rotateView(view, 0, 100000).phi).toBe(MIN_POLAR);
    expect(MIN_POLAR).toBeGreaterThan(0);
    expect(MAX_POLAR).toBeLessThan(Math.PI);
  });
});

describe('zoomView', () => {
  const limits = { min: 1, max: 10 };

  it('steps by a fixed fraction per notch, whatever the device reports', () => {
    expect(zoomView({ ...view, radius: 4 }, 3, limits).radius).toBeCloseTo(
      zoomView({ ...view, radius: 4 }, 240, limits).radius,
      12,
    );
    expect(zoomView({ ...view, radius: 4 }, -1, limits).radius).toBeLessThan(4);
    expect(zoomView({ ...view, radius: 4 }, 1, limits).radius).toBeGreaterThan(4);
  });

  it('holds still for a zero delta and clamps to the limits', () => {
    expect(zoomView({ ...view, radius: 4 }, 0, limits).radius).toBe(4);
    expect(zoomView({ ...view, radius: 1 }, -50, limits).radius).toBe(limits.min);
    expect(zoomView({ ...view, radius: 10 }, 50, limits).radius).toBe(limits.max);
  });
});

describe('panView', () => {
  it('moves the target opposite the drag, in the camera plane', () => {
    const panned = panView(view, 10, 0, 500, DEFAULT_FOV);
    const { right, up } = orbitBasis(view);
    const delta = [
      panned.target[0] - view.target[0],
      panned.target[1] - view.target[1],
      panned.target[2] - view.target[2],
    ];
    expect(dot(delta, right)).toBeLessThan(0);
    expect(dot(delta, up)).toBeCloseTo(0, 12);
    expect(panned.radius).toBe(view.radius);
    expect(panned.theta).toBe(view.theta);
  });

  it('moves the model one pixel per pixel of pointer travel at the target depth', () => {
    const height = 600;
    const dragged = panView(view, 0, height, height, DEFAULT_FOV);
    const travelled = Math.hypot(
      dragged.target[0] - view.target[0],
      dragged.target[1] - view.target[1],
      dragged.target[2] - view.target[2],
    );
    const viewportHeightInWorld = 2 * view.radius * Math.tan((DEFAULT_FOV * Math.PI) / 360);
    expect(travelled).toBeCloseTo(viewportHeightInWorld, 12);
  });
});

describe('frameBounds', () => {
  it('centres on the model and fits its bounding sphere', () => {
    for (const aspect of [0.4, 1, 2.5]) {
      const framed = frameBounds(unitBox, DEFAULT_FOV, aspect);
      expect(framed.target).toEqual(boundsCenter(unitBox));
      const halfVertical = (DEFAULT_FOV * Math.PI) / 360;
      const halfHorizontal = Math.atan(Math.tan(halfVertical) * aspect);
      const visibleRadius = framed.radius * Math.sin(Math.min(halfVertical, halfHorizontal));
      expect(visibleRadius).toBeGreaterThan(boundsDiagonal(unitBox) / 2);
    }
  });

  it('backs off further for a narrower lens', () => {
    expect(frameBounds(unitBox, 20, 1).radius).toBeGreaterThan(frameBounds(unitBox, 60, 1).radius);
  });

  it('keeps the requested angles', () => {
    const framed = frameBounds(unitBox, DEFAULT_FOV, 1, { theta: 0.25, phi: 1.5 });
    expect(framed.theta).toBe(0.25);
    expect(framed.phi).toBe(1.5);
  });
});

describe('zoomLimitsFor', () => {
  it('scales with the model, so mm and metre models feel the same', () => {
    const small = zoomLimitsFor({ min: [0, 0, 0], max: [0.1, 0.1, 0.1] });
    const large = zoomLimitsFor({ min: [0, 0, 0], max: [100, 100, 100] });
    expect(large.min / small.min).toBeCloseTo(1000, 6);
    expect(small.min).toBeLessThan(small.max);
  });
});

describe('triangleGroups', () => {
  it('gives each part its own draw group', () => {
    const model = twoStripModel();
    const groups = triangleGroups(model, model.parts.length);
    expect(groups).toHaveLength(2);
    expect(groups[0].materialIndex).toBe(0);
    expect(groups[1].materialIndex).toBe(1);
    expect(groups[0].start).toBe(0);
    expect(groups[0].count + groups[1].count).toBe(model.triCount);
  });

  it('covers every triangle exactly once even when parts interleave', () => {
    const model = twoStripModel();
    for (let tri = 0; tri < model.triCount; tri++) model.triPart[tri] = tri % 2;
    const groups = triangleGroups(model, 2);
    expect(groups).toHaveLength(model.triCount);
    const drawn = new Uint8Array(model.triCount);
    for (const group of groups) {
      for (let tri = group.start; tri < group.start + group.count; tri++) drawn[tri]++;
      expect(group.materialIndex).toBe(model.triPart[group.start]);
    }
    expect(Array.from(drawn).every((count) => count === 1)).toBe(true);
  });

  it('clamps a part index with no material of its own rather than dropping its triangles', () => {
    const model = twoStripModel();
    const groups = triangleGroups(model, 1);
    expect(groups.every((group) => group.materialIndex === 0)).toBe(true);
    const total = groups.reduce((sum, group) => sum + group.count, 0);
    expect(total).toBe(model.triCount);
  });
});

describe('ThermalScene without a renderer', () => {
  // Everything but `mount` works headless, which is as far as Node can go: there
  // is no WebGL here, so this covers construction, model swap and teardown only.
  it('builds, repaints and tears down a model', () => {
    const scene = new ThermalScene();
    const model = twoStripModel();
    scene.setModel(model);
    expect(scene.getModel()).toBe(model);

    const temperature = Float32Array.from({ length: model.nodeCount }, (_, node) =>
      node === 0 ? Number.NaN : 300 + (20 * node) / model.nodeCount,
    );
    const resolved = scene.setTemperatures(
      temperature,
      { mode: 'auto', min: 0, max: 0, map: 'inferno' },
      293.15,
    );
    expect(resolved.map).toBe('inferno');
    // The NaN node is skipped, so the range comes from the finite ramp alone.
    expect(resolved.min).toBeCloseTo(300, 0);
    expect(resolved.max).toBeCloseTo(320, 0);
    expect(scene.getColorScale()).toEqual(resolved);

    const ambientToMax = scene.resolveColorScale(
      { mode: 'ambientToMax', min: 0, max: 0, map: 'inferno' },
      293.15,
    );
    expect(ambientToMax.min).toBeCloseTo(293.15, 6);

    scene.setWireframe(true);
    scene.setSectionEnabled(true);
    scene.setSectionAxis('y');
    const range = scene.getSectionOffsetRange();
    expect(range.min).toBeCloseTo(model.bbox.min[1], 6);
    expect(range.max).toBeCloseTo(model.bbox.max[1], 6);
    scene.setOverlayVisible('featureEdges', true);
    scene.setModel(null);
    expect(scene.getModel()).toBeNull();
    scene.dispose();
  });

  it('frames the model and keeps the camera view round-trippable', () => {
    const scene = new ThermalScene();
    scene.setModel(twoStripModel());
    const view = scene.getCameraView();
    expect(view.radius).toBeGreaterThan(0);
    scene.setCameraView({ ...view, theta: 0.4 });
    expect(scene.getCameraView().theta).toBe(0.4);
    scene.dispose();
  });
});

describe('ThermalScene click routing', () => {
  const LEFT_PART: Target = { type: 'part', partId: 'part-0' };
  const RIGHT_PART: Target = { type: 'part', partId: 'part-1' };
  // `twoStripModel` lays its two parts end to end along X in the z = 0 plane.
  const OVER_LEFT: Vec3 = [0.051, 0.007, 0];
  const OVER_RIGHT: Vec3 = [0.151, 0.007, 0];
  const OVER_NOTHING: Vec3 = [0.05, 0.5, 0];

  function loadedScene(): ThermalScene {
    const scene = new ThermalScene();
    scene.setModel(twoStripModel());
    return scene;
  }

  /**
   * Node has no canvas, so a click is driven through the listener the canvas would
   * call, and with no canvas to measure it always picks at the view centre — which
   * is why these tests aim the camera at a part instead of moving the pointer.
   */
  function clickInViewport(scene: ThermalScene, shiftKey = false): void {
    const listeners = scene as unknown as { onPointerUp(event: PointerEvent): void };
    listeners.onPointerUp({
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      button: 0,
      shiftKey,
    } as unknown as PointerEvent);
  }

  function aimAt(scene: ThermalScene, target: Vec3): void {
    scene.setCameraView({ ...scene.getCameraView(), target });
  }

  it('aims the camera at whichever part the test means to click', () => {
    const scene = loadedScene();
    aimAt(scene, OVER_LEFT);
    expect(scene.pickAt(0, 0)?.target).toEqual(LEFT_PART);
    aimAt(scene, OVER_RIGHT);
    expect(scene.pickAt(0, 0)?.target).toEqual(RIGHT_PART);
    aimAt(scene, OVER_NOTHING);
    expect(scene.pickAt(0, 0)).toBeNull();
    scene.dispose();
  });

  it('replaces the selection and leaves the draft alone when not collecting', () => {
    const scene = loadedScene();
    aimAt(scene, OVER_LEFT);
    clickInViewport(scene);
    expect(scene.getSelection()).toEqual([LEFT_PART]);

    aimAt(scene, OVER_RIGHT);
    clickInViewport(scene);
    expect(scene.getSelection()).toEqual([RIGHT_PART]);
    expect(scene.getDraft()).toEqual([]);
    scene.dispose();
  });

  it('stages into the draft and toggles a repeat back out while collecting', () => {
    const scene = loadedScene();
    scene.setSelection([LEFT_PART]);
    scene.setCollecting(true);

    aimAt(scene, OVER_LEFT);
    clickInViewport(scene);
    expect(scene.getDraft()).toEqual([LEFT_PART]);

    aimAt(scene, OVER_RIGHT);
    clickInViewport(scene);
    expect(scene.getDraft()).toEqual([LEFT_PART, RIGHT_PART]);

    clickInViewport(scene);
    expect(scene.getDraft()).toEqual([LEFT_PART]);

    // The part tree and the contacts panel both read the selection; staging a group
    // must not move it under them.
    expect(scene.getSelection()).toEqual([LEFT_PART]);
    scene.dispose();
  });

  it('emits onDraftChange in place of onSelectionChange while collecting', () => {
    const scene = loadedScene();
    const drafts: Target[][] = [];
    const selections: Target[][] = [];
    scene.setHandlers({
      onDraftChange: (draft) => drafts.push(draft),
      onSelectionChange: (selection) => selections.push(selection),
    });

    scene.setCollecting(true);
    aimAt(scene, OVER_LEFT);
    clickInViewport(scene, true);
    expect(drafts).toEqual([[LEFT_PART]]);
    expect(selections).toEqual([]);

    scene.setCollecting(false);
    clickInViewport(scene);
    expect(drafts).toHaveLength(1);
    expect(selections).toEqual([[LEFT_PART]]);
    scene.dispose();
  });

  it('keeps the staged group when a click misses the model', () => {
    const scene = loadedScene();
    scene.setCollecting(true);
    aimAt(scene, OVER_LEFT);
    clickInViewport(scene);
    aimAt(scene, OVER_NOTHING);
    clickInViewport(scene);
    expect(scene.getDraft()).toEqual([LEFT_PART]);
    scene.dispose();
  });
});
