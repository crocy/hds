/**
 * The draggable section plane of spec §7.1 and §8: a translucent quad with a
 * handle along its own normal, snapped to a principal axis, that both clips the
 * 3D view and tells the analysis layer where to cut.
 *
 * The gizmo does not section anything itself. It emits a `SectionPlane`; the
 * caller runs `geometry/section` and `analysis/slice2d` against it and hands the
 * resulting `SectionField2D` back through `setField`, which draws it as a texture
 * on the plane. Keeping the cut out of the viewer is what lets the same plane feed
 * the profile plot and the filled field without a second definition of "the cut".
 *
 * Everything above the `SectionGizmo` class is pure maths over numbers, so the
 * drag projection and the plane-space extent are unit-testable in Node.
 */

import * as THREE from 'three';
import {
  CELL_AMBIENT,
  CELL_OUTSIDE,
  type Bounds,
  type ColormapId,
  type SectionField2D,
  type SectionPlane,
  type Vec3,
} from '@/core/types';
import { planeBasis, type PlaneBasis } from '@/geometry/section';
import { writeRgbaBytes } from './colormap';

export type SectionAxis = 'x' | 'y' | 'z';

export const SECTION_AXES: readonly SectionAxis[] = ['x', 'y', 'z'];

export const SECTION_PLANE_COLOR = 0x38bdf8;
/** Tint of the bare plane: enough to read as a surface, not enough to veil the model. */
const IDLE_PLANE_OPACITY = 0.1;
const FIELD_PLANE_OPACITY = 0.95;
export const SECTION_HANDLE_COLOR = 0xffb400;

/** Plane-space rectangle, in the same convention as `analysis/slice2d`. */
export interface PlaneExtent {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

// ---------------------------------------------------------------------------
// Pure maths
// ---------------------------------------------------------------------------

export function axisNormal(axis: SectionAxis, sign: 1 | -1 = 1): Vec3 {
  return [axis === 'x' ? sign : 0, axis === 'y' ? sign : 0, axis === 'z' ? sign : 0];
}

/** The principal axis a normal is closest to, keeping its sign. Zero vectors read as +X. */
export function snapNormalToAxis(normal: Vec3): Vec3 {
  let axis = 0;
  for (let k = 1; k < 3; k++) {
    if (Math.abs(normal[k]) > Math.abs(normal[axis])) axis = k;
  }
  if (!(Math.abs(normal[axis]) > 0)) return [1, 0, 0];
  const sign = normal[axis] < 0 ? -1 : 1;
  return [axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0];
}

export function normalizeVector(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!(length > 0)) return [1, 0, 0];
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * Signed distance of the plane from the world origin along its normal — the one
 * number a sweep along the normal changes, and what the UI's slider drives.
 */
export function planeOffset(plane: SectionPlane): number {
  const normal = normalizeVector(plane.normal);
  return plane.origin[0] * normal[0] + plane.origin[1] * normal[1] + plane.origin[2] * normal[2];
}

export function planeFromOffset(normal: Vec3, offset: number): SectionPlane {
  const unit = normalizeVector(normal);
  return { normal: unit, origin: [unit[0] * offset, unit[1] * offset, unit[2] * offset] };
}

function corners(bounds: Bounds): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    out.push([
      i & 1 ? bounds.max[0] : bounds.min[0],
      i & 2 ? bounds.max[1] : bounds.min[1],
      i & 4 ? bounds.max[2] : bounds.min[2],
    ]);
  }
  return out;
}

/** The offsets at which the plane first touches and last leaves the bounding box. */
export function offsetRange(bounds: Bounds, normal: Vec3): { min: number; max: number } {
  const unit = normalizeVector(normal);
  let min = Infinity;
  let max = -Infinity;
  for (const corner of corners(bounds)) {
    const d = corner[0] * unit[0] + corner[1] * unit[1] + corner[2] * unit[2];
    if (d < min) min = d;
    if (d > max) max = d;
  }
  if (!Number.isFinite(min)) return { min: 0, max: 0 };
  return { min, max };
}

export function clampOffset(offset: number, bounds: Bounds, normal: Vec3): number {
  const { min, max } = offsetRange(bounds, normal);
  if (!Number.isFinite(offset)) return (min + max) / 2;
  return offset < min ? min : offset > max ? max : offset;
}

/**
 * The plane-space rectangle covering the model, which is what `slice2d` should be
 * rasterised over. `margin` is a fraction of the larger span, so the field does not
 * stop exactly at the silhouette.
 */
export function sectionExtent(bounds: Bounds, plane: SectionPlane, margin = 0.04): PlaneExtent {
  const basis = planeBasis(plane);
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const corner of corners(bounds)) {
    const [u, v] = basis.projectToPlane(corner);
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  if (!Number.isFinite(uMin)) return { uMin: -0.5, uMax: 0.5, vMin: -0.5, vMax: 0.5 };
  const pad = Math.max(uMax - uMin, vMax - vMin) * margin;
  return { uMin: uMin - pad, uMax: uMax + pad, vMin: vMin - pad, vMax: vMax + pad };
}

/**
 * Parameter along `axis` of the point closest to the ray — the projection that
 * turns a pointer drag into a sweep along the plane normal. Null when the ray is
 * within `parallelEpsilon` of parallel to the axis, where the answer is unstable
 * and the drag should simply not move.
 */
export function closestPointOnAxis(
  axisOrigin: Vec3,
  axisDir: Vec3,
  rayOrigin: Vec3,
  rayDir: Vec3,
  parallelEpsilon = 1e-4,
): number | null {
  const rx = axisOrigin[0] - rayOrigin[0];
  const ry = axisOrigin[1] - rayOrigin[1];
  const rz = axisOrigin[2] - rayOrigin[2];
  const a = axisDir[0] ** 2 + axisDir[1] ** 2 + axisDir[2] ** 2;
  const e = rayDir[0] ** 2 + rayDir[1] ** 2 + rayDir[2] ** 2;
  const b = axisDir[0] * rayDir[0] + axisDir[1] * rayDir[1] + axisDir[2] * rayDir[2];
  const c = axisDir[0] * rx + axisDir[1] * ry + axisDir[2] * rz;
  const f = rayDir[0] * rx + rayDir[1] * ry + rayDir[2] * rz;
  const denominator = a * e - b * b;
  if (!(Math.abs(denominator) > parallelEpsilon * a * e)) return null;
  return (b * f - c * e) / denominator;
}

export interface SectionFieldStyle {
  map: ColormapId;
  min: number;
  max: number;
  /**
   * Draw the open-air cells too. Off by default: filling the whole rectangle with
   * the ambient colour turns the plane into a wall and hides the model behind it.
   */
  showAmbient?: boolean;
}

/**
 * RGBA bytes for the field texture. Cells outside the model, and any cell whose
 * value is not finite, are written fully transparent rather than to the bottom of
 * the colour scale.
 */
export function writeSectionFieldTexture(
  field: SectionField2D,
  style: SectionFieldStyle,
  out: Uint8Array,
): void {
  writeRgbaBytes(field.values, style.min, style.max, style.map, out);
  const showAmbient = style.showAmbient === true;
  for (let cell = 0; cell < field.mask.length; cell++) {
    const mask = field.mask[cell];
    if (mask === CELL_OUTSIDE || (!showAmbient && mask === CELL_AMBIENT)) out[cell * 4 + 3] = 0;
  }
}

// ---------------------------------------------------------------------------
// Gizmo
// ---------------------------------------------------------------------------

const DEFAULT_BOUNDS: Bounds = { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };

export interface SectionGizmoOptions {
  /** Fired whenever the plane moves, including during a drag. */
  onChange?(plane: SectionPlane): void;
}

export class SectionGizmo {
  readonly object = new THREE.Group();

  private readonly planeGroup = new THREE.Group();
  private readonly quad: THREE.Mesh;
  private readonly quadMaterial: THREE.MeshBasicMaterial;
  private readonly outline: THREE.LineSegments;
  private readonly handle = new THREE.Group();
  private readonly handleParts: THREE.Mesh[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];

  private readonly clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  private readonly clipPlanes: THREE.Plane[] = [this.clipPlane];

  private bounds: Bounds = DEFAULT_BOUNDS;
  private normal: Vec3 = [1, 0, 0];
  private offset = 0;
  private basis: PlaneBasis = planeBasis({ normal: [1, 0, 0], origin: [0, 0, 0] });
  private extent: PlaneExtent = { uMin: -0.5, uMax: 0.5, vMin: -0.5, vMax: 0.5 };
  private enabled = false;
  private clipping = true;
  private texture: THREE.DataTexture | null = null;
  private textureBytes: Uint8Array = new Uint8Array(0);
  private dragStartOffset = 0;
  private dragAnchor: number | null = null;
  private readonly dragAxisOrigin: [number, number, number] = [0, 0, 0];

  constructor(private readonly options: SectionGizmoOptions = {}) {
    this.object.name = 'section-gizmo';
    this.object.visible = false;
    this.object.add(this.planeGroup);

    this.quadMaterial = new THREE.MeshBasicMaterial({
      color: SECTION_PLANE_COLOR,
      transparent: true,
      opacity: IDLE_PLANE_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });
    const quadGeometry = new THREE.PlaneGeometry(1, 1);
    this.quad = new THREE.Mesh(quadGeometry, this.quadMaterial);
    this.quad.renderOrder = 1;
    this.quad.frustumCulled = false;

    const outlineMaterial = new THREE.LineBasicMaterial({
      color: SECTION_PLANE_COLOR,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      toneMapped: false,
    });
    const outlineGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.5, -0.5, 0),
      new THREE.Vector3(0.5, -0.5, 0),
      new THREE.Vector3(0.5, -0.5, 0),
      new THREE.Vector3(0.5, 0.5, 0),
      new THREE.Vector3(0.5, 0.5, 0),
      new THREE.Vector3(-0.5, 0.5, 0),
      new THREE.Vector3(-0.5, 0.5, 0),
      new THREE.Vector3(-0.5, -0.5, 0),
    ]);
    this.outline = new THREE.LineSegments(outlineGeometry, outlineMaterial);
    this.outline.renderOrder = 4;
    this.outline.frustumCulled = false;
    // Child of the quad, so the unit square inherits the extent scale.
    this.quad.add(this.outline);
    this.planeGroup.add(this.quad);

    const handleMaterial = new THREE.MeshBasicMaterial({
      color: SECTION_HANDLE_COLOR,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
      toneMapped: false,
    });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 12), handleMaterial);
    shaft.rotation.x = Math.PI / 2;
    const coneGeometry = new THREE.ConeGeometry(0.06, 0.18, 16);
    for (const sign of [1, -1]) {
      const cone = new THREE.Mesh(coneGeometry, handleMaterial);
      cone.position.z = sign * 0.5;
      cone.rotation.x = (sign * Math.PI) / 2;
      this.handleParts.push(cone);
    }
    this.handleParts.push(shaft);
    for (const part of this.handleParts) {
      part.renderOrder = 5;
      part.frustumCulled = false;
      this.handle.add(part);
    }
    this.planeGroup.add(this.handle);

    this.disposables.push(
      quadGeometry,
      this.quadMaterial,
      outlineGeometry,
      outlineMaterial,
      handleMaterial,
      shaft.geometry,
      coneGeometry,
    );

    this.setBounds(DEFAULT_BOUNDS);
  }

  /** Re-frames the gizmo on a new model and re-centres the plane. */
  setBounds(bounds: Bounds | null): void {
    this.bounds = bounds ?? DEFAULT_BOUNDS;
    const range = offsetRange(this.bounds, this.normal);
    this.offset = (range.min + range.max) / 2;
    this.refresh();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.object.visible = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Whether the plane also clips the shaded mesh, as opposed to only marking the cut. */
  setClipping(clipping: boolean): void {
    this.clipping = clipping;
  }

  isClipping(): boolean {
    return this.clipping;
  }

  /** The array to hand to `Material.clippingPlanes`, or null when nothing is clipped. */
  getClippingPlanes(): THREE.Plane[] | null {
    return this.enabled && this.clipping ? this.clipPlanes : null;
  }

  /** Material on the far side of the cut is hidden, so it must not be pickable either. */
  isPointVisible(point: THREE.Vector3): boolean {
    if (!this.enabled || !this.clipping) return true;
    return this.clipPlane.distanceToPoint(point) >= 0;
  }

  getPlane(): SectionPlane {
    return planeFromOffset(this.normal, this.offset);
  }

  getBasis(): PlaneBasis {
    return this.basis;
  }

  getExtent(): PlaneExtent {
    return this.extent;
  }

  setPlane(plane: SectionPlane): void {
    this.normal = normalizeVector(plane.normal);
    this.offset = clampOffset(planeOffset(plane), this.bounds, this.normal);
    this.refresh();
  }

  setAxis(axis: SectionAxis, sign: 1 | -1 = 1): void {
    this.normal = axisNormal(axis, sign);
    this.offset = clampOffset(this.offset, this.bounds, this.normal);
    this.refresh();
  }

  snapToNearestAxis(): void {
    this.normal = snapNormalToAxis(this.normal);
    this.offset = clampOffset(this.offset, this.bounds, this.normal);
    this.refresh();
  }

  getOffset(): number {
    return this.offset;
  }

  getOffsetRange(): { min: number; max: number } {
    return offsetRange(this.bounds, this.normal);
  }

  setOffset(offset: number): void {
    const clamped = clampOffset(offset, this.bounds, this.normal);
    if (clamped === this.offset) return;
    this.offset = clamped;
    this.refresh();
  }

  /**
   * Draws a field the caller computed for *this* plane. Its uv extent must come
   * from the same basis (`getBasis()` / `getExtent()`), or the texture will not
   * line up with the cut.
   */
  setField(field: SectionField2D | null, style?: SectionFieldStyle): void {
    if (!field || !style) {
      this.clearFieldTexture();
      this.updateVisuals();
      return;
    }

    const cells = field.width * field.height;
    if (!this.texture || this.textureBytes.length !== cells * 4) {
      this.disposeTexture();
      this.textureBytes = new Uint8Array(cells * 4);
      this.texture = new THREE.DataTexture(this.textureBytes, field.width, field.height);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.magFilter = THREE.NearestFilter;
      this.texture.minFilter = THREE.LinearFilter;
      this.texture.generateMipmaps = false;
    }
    writeSectionFieldTexture(field, style, this.textureBytes);
    this.texture.needsUpdate = true;
    this.quadMaterial.map = this.texture;
    // The tint multiplies the map, so it has to go or the field is shaded sky blue.
    this.quadMaterial.color.setHex(0xffffff);
    this.quadMaterial.opacity = FIELD_PLANE_OPACITY;
    this.quadMaterial.needsUpdate = true;

    this.extent = { uMin: field.uMin, uMax: field.uMax, vMin: field.vMin, vMax: field.vMax };
    this.applyTransforms();
  }

  /** A field belongs to one plane position; once the plane moves it is a lie. */
  private clearFieldTexture(): void {
    if (!this.texture) return;
    this.quadMaterial.map = null;
    this.quadMaterial.color.setHex(SECTION_PLANE_COLOR);
    this.quadMaterial.opacity = IDLE_PLANE_OPACITY;
    this.quadMaterial.needsUpdate = true;
    this.disposeTexture();
  }

  /** True when the pointer ray is over a drag handle. */
  hitTest(raycaster: THREE.Raycaster): boolean {
    if (!this.enabled) return false;
    this.object.updateMatrixWorld(true);
    return raycaster.intersectObjects(this.handleParts, false).length > 0;
  }

  beginDrag(raycaster: THREE.Raycaster): boolean {
    if (!this.hitTest(raycaster)) return false;
    const centre = this.planeCentre();
    this.dragAxisOrigin[0] = centre[0];
    this.dragAxisOrigin[1] = centre[1];
    this.dragAxisOrigin[2] = centre[2];
    this.dragStartOffset = this.offset;
    this.dragAnchor = this.projectRay(raycaster);
    return this.dragAnchor !== null;
  }

  isDragging(): boolean {
    return this.dragAnchor !== null;
  }

  /** Returns true when the plane actually moved. */
  updateDrag(raycaster: THREE.Raycaster): boolean {
    if (this.dragAnchor === null) return false;
    const current = this.projectRay(raycaster);
    if (current === null) return false;
    const previous = this.offset;
    this.setOffset(this.dragStartOffset + (current - this.dragAnchor));
    return this.offset !== previous;
  }

  endDrag(): void {
    this.dragAnchor = null;
  }

  dispose(): void {
    this.disposeTexture();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.handleParts.length = 0;
    this.handle.clear();
    this.quad.clear();
    this.planeGroup.clear();
    this.object.clear();
  }

  private projectRay(raycaster: THREE.Raycaster): number | null {
    const { origin, direction } = raycaster.ray;
    return closestPointOnAxis(
      this.dragAxisOrigin,
      this.normal,
      [origin.x, origin.y, origin.z],
      [direction.x, direction.y, direction.z],
    );
  }

  /** The plane point nearest the model, which is where the gizmo is drawn. */
  private planeCentre(): Vec3 {
    const centre: Vec3 = [
      (this.bounds.min[0] + this.bounds.max[0]) / 2,
      (this.bounds.min[1] + this.bounds.max[1]) / 2,
      (this.bounds.min[2] + this.bounds.max[2]) / 2,
    ];
    const distance =
      centre[0] * this.normal[0] +
      centre[1] * this.normal[1] +
      centre[2] * this.normal[2] -
      this.offset;
    return [
      centre[0] - this.normal[0] * distance,
      centre[1] - this.normal[1] * distance,
      centre[2] - this.normal[2] * distance,
    ];
  }

  private refresh(): void {
    this.clearFieldTexture();
    this.updateVisuals();
    this.options.onChange?.(this.getPlane());
  }

  private updateVisuals(): void {
    const plane = this.getPlane();
    this.basis = planeBasis(plane);
    this.extent = sectionExtent(this.bounds, plane);
    this.applyTransforms();
  }

  private applyTransforms(): void {
    const plane = this.getPlane();
    // The half-space the normal points into is the one removed, so the camera has
    // to sit on the normal's side to look into the cut. Flipping the sign of the
    // axis is what turns the cut around.
    this.clipPlane.normal.set(-this.normal[0], -this.normal[1], -this.normal[2]);
    this.clipPlane.constant = this.offset;

    const { axisU, axisV, normal } = this.basis;
    const rotation = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(axisU[0], axisU[1], axisU[2]),
      new THREE.Vector3(axisV[0], axisV[1], axisV[2]),
      new THREE.Vector3(normal[0], normal[1], normal[2]),
    );
    this.planeGroup.quaternion.setFromRotationMatrix(rotation);
    this.planeGroup.position.set(plane.origin[0], plane.origin[1], plane.origin[2]);

    const width = Math.max(1e-6, this.extent.uMax - this.extent.uMin);
    const height = Math.max(1e-6, this.extent.vMax - this.extent.vMin);
    const centreU = (this.extent.uMin + this.extent.uMax) / 2;
    const centreV = (this.extent.vMin + this.extent.vMax) / 2;
    this.quad.scale.set(width, height, 1);
    this.quad.position.set(centreU, centreV, 0);
    this.handle.position.set(centreU, centreV, 0);
    this.handle.scale.setScalar(Math.min(width, height) * 0.4);
    this.object.updateMatrixWorld(true);
  }

  private disposeTexture(): void {
    this.texture?.dispose();
    this.texture = null;
    this.textureBytes = new Uint8Array(0);
  }
}
