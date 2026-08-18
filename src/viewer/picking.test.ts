import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Target, ThermalModel } from '@/core/types';
import { twoStripModel } from '@/core/testModels';
import { DRAFT_COLOR, HOVER_COLOR, Picker, SELECTION_COLOR } from './picking';

const LEFT_PART: Target = { type: 'part', partId: 'part-0' };
const RIGHT_PART: Target = { type: 'part', partId: 'part-1' };

function meshFor(model: ThermalModel): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(model.nodes, 3));
  geometry.setIndex(new THREE.BufferAttribute(model.tris, 1));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

function loadedPicker(): Picker {
  const picker = new Picker(new THREE.PerspectiveCamera());
  const model = twoStripModel();
  picker.setModel(model, meshFor(model));
  return picker;
}

/** The highlight layers, in the order the picker stacks them into its group. */
function layers(picker: Picker): [THREE.Object3D, THREE.Object3D, THREE.Object3D] {
  const [selection, draft, hover] = picker.object.children;
  return [selection, draft, hover];
}

function isDrawing(layer: THREE.Object3D): boolean {
  return layer.children.some((object) => object.visible);
}

describe('Picker draft layer', () => {
  it('stages a draft alongside the selection without disturbing it', () => {
    const picker = loadedPicker();
    picker.setSelection([LEFT_PART]);
    picker.setDraft([RIGHT_PART]);

    expect(picker.getSelection()).toEqual([LEFT_PART]);
    expect(picker.getDraft()).toEqual([RIGHT_PART]);
    const [selection, draft] = layers(picker);
    expect(isDrawing(selection)).toBe(true);
    expect(isDrawing(draft)).toBe(true);
    picker.dispose();
  });

  it('copies what it is given, so the caller stays the owner of the array', () => {
    const picker = loadedPicker();
    const staged = [LEFT_PART];
    picker.setDraft(staged);
    staged.push(RIGHT_PART);
    expect(picker.getDraft()).toEqual([LEFT_PART]);
    picker.dispose();
  });

  it('stops drawing once the draft is emptied', () => {
    const picker = loadedPicker();
    picker.setDraft([LEFT_PART]);
    picker.setDraft([]);
    expect(isDrawing(layers(picker)[1])).toBe(false);
    picker.dispose();
  });

  it('drops the draft with the model, as the selection is dropped', () => {
    const picker = loadedPicker();
    picker.setSelection([LEFT_PART]);
    picker.setDraft([RIGHT_PART]);
    picker.setModel(null, null);
    expect(picker.getDraft()).toEqual([]);
    expect(picker.getSelection()).toEqual([]);
    expect(isDrawing(layers(picker)[1])).toBe(false);
    picker.dispose();
  });

  it('lets go of all three layers on dispose', () => {
    const picker = loadedPicker();
    picker.setDraft([LEFT_PART]);
    picker.dispose();
    expect(picker.object.children).toHaveLength(0);
  });

  it('draws above the selection and below hover, in its own colour', () => {
    const picker = loadedPicker();
    const [selection, draft, hover] = layers(picker).map((layer) => layer.children[0].renderOrder);
    expect(draft).toBeGreaterThan(selection);
    expect(draft).toBeLessThan(hover);
    expect(new Set([DRAFT_COLOR, SELECTION_COLOR, HOVER_COLOR]).size).toBe(3);
    picker.dispose();
  });
});
