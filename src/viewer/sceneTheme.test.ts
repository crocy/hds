/**
 * The viewer's two per-theme colours: that each clears the ground it is read
 * against, and that changing them actually reaches the pixels.
 *
 * `mount` needs WebGL, so this stays on the same headless side as `scene.test.ts`:
 * the palette is pure, and the vertex colours can be read off the scene without a
 * renderer.
 */

import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { twoStripModel } from '@/core/testModels';
import { contrastRatio, hexFromNumber, parseHexColor } from '@/ui/theme';
import { sample, srgbToLinear } from './colormap';
import { BACKGROUND_COLORS, NO_DATA_COLORS, ThermalScene } from './scene';

/** WCAG's threshold for a graphical object, the floor the spec measures against. */
const CONTRAST_FLOOR = 3;

const THEMES = ['dark', 'light'] as const;

function ratio(a: number, b: number): number {
  return contrastRatio(parseHexColor(hexFromNumber(a)), parseHexColor(hexFromNumber(b)));
}

describe('viewer palette contrast', () => {
  it.each(THEMES)('%s: unsolved nodes clear their own background', (theme) => {
    expect(ratio(NO_DATA_COLORS[theme], BACKGROUND_COLORS[theme])).toBeGreaterThanOrEqual(
      CONTRAST_FLOOR,
    );
  });

  // Sampled rather than written out, so the property still holds if the ramp is retuned.
  // Only the light background is asserted: dark's cold end measures 1.07 and always
  // has, which the spec records as the cost of a near-black viewport rather than
  // anything this change introduced.
  it('keeps both ends of the inferno ramp clear of the light background', () => {
    const background = parseHexColor(hexFromNumber(BACKGROUND_COLORS.light));
    for (const t of [0, 1]) {
      expect(contrastRatio(sample('inferno', t), background), `t = ${t}`).toBeGreaterThanOrEqual(
        CONTRAST_FLOOR,
      );
    }
  });

  it('leaves dark theme on the values that shipped before the theme choice existed', () => {
    expect(BACKGROUND_COLORS.dark).toBe(0x0c0c10);
    expect(NO_DATA_COLORS.dark).toBe(0x5a6070);
  });
});

/**
 * What a theme change has to reach. The colour attribute is private and there is no
 * frame to read back in Node, so the repaint is proved on the buffer itself.
 */
interface SceneInternals {
  scene: THREE.Scene;
  colors: Float32Array;
  colorAttribute: THREE.BufferAttribute | null;
  needsRender: boolean;
}

function internals(scene: ThermalScene): SceneInternals {
  return scene as unknown as SceneInternals;
}

function expectNodeColor(colors: Float32Array, node: number, color: number): void {
  const expected = [16, 8, 0].map((shift) => srgbToLinear(((color >> shift) & 0xff) / 255));
  for (let channel = 0; channel < 3; channel++) {
    expect(colors[node * 3 + channel], `node ${node} channel ${channel}`).toBeCloseTo(
      expected[channel],
      6,
    );
  }
}

describe('ThermalScene theme colours', () => {
  it('rewrites the vertex colours, not just the frame, when the no-data grey changes', () => {
    const scene = new ThermalScene();
    scene.setModel(twoStripModel());
    const state = internals(scene);
    expectNodeColor(state.colors, 0, NO_DATA_COLORS.dark);

    const version = state.colorAttribute?.version ?? -1;
    state.needsRender = false;
    scene.setNoDataColor(NO_DATA_COLORS.light);

    expectNodeColor(state.colors, 0, NO_DATA_COLORS.light);
    // Without this the new colours sit in a buffer three never uploads.
    expect(state.colorAttribute?.version).toBeGreaterThan(version);
    expect(state.needsRender).toBe(true);
    scene.dispose();
  });

  it('repaints only the unsolved nodes of a solved model', () => {
    const scene = new ThermalScene();
    const model = twoStripModel();
    scene.setModel(model);
    const temperature = Float32Array.from({ length: model.nodeCount }, (_, node) =>
      node === 0 ? Number.NaN : 300 + node,
    );
    scene.setTemperatures(temperature, { mode: 'auto', min: 0, max: 0, map: 'inferno' }, 293.15);

    const state = internals(scene);
    const solved = Array.from(state.colors.slice(3, 6));
    expectNodeColor(state.colors, 0, NO_DATA_COLORS.dark);

    scene.setNoDataColor(NO_DATA_COLORS.light);
    expectNodeColor(state.colors, 0, NO_DATA_COLORS.light);
    expect(Array.from(state.colors.slice(3, 6))).toEqual(solved);
    scene.dispose();
  });

  it('keeps both colours across a model swap, so nothing has to re-apply them', () => {
    const scene = new ThermalScene();
    scene.setBackground(BACKGROUND_COLORS.light);
    scene.setNoDataColor(NO_DATA_COLORS.light);

    scene.setModel(twoStripModel());
    const state = internals(scene);
    expectNodeColor(state.colors, 0, NO_DATA_COLORS.light);
    expect((state.scene.background as THREE.Color).getHex()).toBe(BACKGROUND_COLORS.light);
    scene.dispose();
  });

  it('holds the background as the object the scene and the clear colour both read', () => {
    const scene = new ThermalScene();
    const background = internals(scene).scene.background as THREE.Color;
    expect(background.getHex()).toBe(BACKGROUND_COLORS.dark);

    scene.setBackground(BACKGROUND_COLORS.light);
    // Mutated in place, so a mounted renderer's clear colour is the same object.
    expect(internals(scene).scene.background).toBe(background);
    expect(background.getHex()).toBe(BACKGROUND_COLORS.light);
    scene.dispose();
  });
});
