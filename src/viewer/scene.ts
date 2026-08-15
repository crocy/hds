/**
 * The 3D view: renderer, camera, shaded mesh, and the imperative surface the React
 * layer drives it through.
 *
 * Deliberately React-free. The UI owns the `Scenario` and calls methods here; this
 * class owns nothing but what it takes to draw. It composes the three other viewer
 * pieces — `Picker` (selection), `Overlays` (scenario markers) and `SectionGizmo`
 * (cut plane) — so the UI has one object to talk to.
 *
 * Visual reference is the `thermal_model_3d.html` prototype: dark background,
 * per-vertex inferno colours on a Phong mesh, Z-up orbit camera, ambient plus two
 * directional lights. Panning and the section clip are the additions.
 *
 * Rendering is on demand: every mutator marks the frame dirty, so a still view
 * costs nothing. Anything reaching past this API to mutate the scene must call
 * `invalidate()`.
 *
 * All the camera maths above the class is pure, so the orbit, pan and framing
 * behaviour is unit-testable in Node where there is no WebGL.
 */

import * as THREE from 'three';
import type {
  Bounds,
  ColorScale,
  ColormapId,
  PartOverride,
  Scenario,
  SectionField2D,
  SectionPlane,
  Target,
  ThermalModel,
  Vec3,
} from '@/core/types';
import { resolveScaleRange, srgbToLinear, writeVertexColors } from './colormap';
import { Overlays, type OverlayKind } from './overlays';
import { Picker, worldPerPixel, type PickHit, type SelectionMode } from './picking';
import {
  SectionGizmo,
  type PlaneExtent,
  type SectionAxis,
  type SectionFieldStyle,
} from './sectionGizmo';
import type { PlaneBasis } from '@/geometry/section';

export const BACKGROUND_COLOR = 0x0c0c10;
export const DEFAULT_FOV = 38;

/** Prototype view angles, which show the housing's top plate and two sides. */
export const DEFAULT_THETA = -1.05;
export const DEFAULT_PHI = 1.02;

/** Radians per pixel of drag, from the prototype. */
export const ORBIT_SENSITIVITY = 0.0067;
/** Fraction of the orbit radius per wheel notch. */
export const ZOOM_STEP = 0.09;
/** Poles are excluded: at phi = 0 the up vector and the view direction are parallel. */
export const MIN_POLAR = 0.06;
export const MAX_POLAR = 3.08;

/** Nodes with no temperature — insulator parts, or before the first solve. */
export const NO_DATA_COLOR = 0x5a6070;

// ---------------------------------------------------------------------------
// Camera maths
// ---------------------------------------------------------------------------

/** Z-up spherical orbit state. Serialisable, so a project file can restore the view. */
export interface CameraView {
  /** Azimuth about +Z, radians. */
  theta: number;
  /** Polar angle from +Z, radians, in (0, π). */
  phi: number;
  radius: number;
  target: Vec3;
}

export interface ZoomLimits {
  min: number;
  max: number;
}

export function boundsCenter(bounds: Bounds): Vec3 {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

export function boundsDiagonal(bounds: Bounds): number {
  const diagonal = Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
  return Number.isFinite(diagonal) && diagonal > 0 ? diagonal : 1;
}

export function orbitPosition(view: CameraView): Vec3 {
  const sinPhi = Math.sin(view.phi);
  return [
    view.target[0] + view.radius * sinPhi * Math.cos(view.theta),
    view.target[1] + view.radius * sinPhi * Math.sin(view.theta),
    view.target[2] + view.radius * Math.cos(view.phi),
  ];
}

/** Camera-space right and up in world coordinates, for pan. */
export function orbitBasis(view: CameraView): { right: Vec3; up: Vec3 } {
  const cosTheta = Math.cos(view.theta);
  const sinTheta = Math.sin(view.theta);
  const cosPhi = Math.cos(view.phi);
  const sinPhi = Math.sin(view.phi);
  return {
    right: [-sinTheta, cosTheta, 0],
    up: [-cosPhi * cosTheta, -cosPhi * sinTheta, sinPhi],
  };
}

export function rotateView(
  view: CameraView,
  dxPixels: number,
  dyPixels: number,
  sensitivity = ORBIT_SENSITIVITY,
): CameraView {
  const phi = view.phi - dyPixels * sensitivity;
  return {
    ...view,
    theta: view.theta - dxPixels * sensitivity,
    phi: phi < MIN_POLAR ? MIN_POLAR : phi > MAX_POLAR ? MAX_POLAR : phi,
  };
}

/** One wheel notch is one step, whatever the device reports for its magnitude. */
export function zoomView(view: CameraView, wheelDeltaY: number, limits: ZoomLimits): CameraView {
  const radius = view.radius * (1 + Math.sign(wheelDeltaY) * ZOOM_STEP);
  return {
    ...view,
    radius: radius < limits.min ? limits.min : radius > limits.max ? limits.max : radius,
  };
}

/**
 * Drags the target under the cursor: one pixel of pointer movement moves the model
 * by one pixel's worth of world distance at the target's depth.
 */
export function panView(
  view: CameraView,
  dxPixels: number,
  dyPixels: number,
  viewportHeightPixels: number,
  fovDegrees: number,
): CameraView {
  const perPixel = worldPerPixel(fovDegrees, viewportHeightPixels, view.radius);
  const { right, up } = orbitBasis(view);
  return {
    ...view,
    target: [
      view.target[0] - right[0] * dxPixels * perPixel + up[0] * dyPixels * perPixel,
      view.target[1] - right[1] * dxPixels * perPixel + up[1] * dyPixels * perPixel,
      view.target[2] - right[2] * dxPixels * perPixel + up[2] * dyPixels * perPixel,
    ],
  };
}

/** Distance at which the model's bounding sphere fills `margin` of the smaller field of view. */
export function frameBounds(
  bounds: Bounds,
  fovDegrees: number,
  aspect: number,
  angles: { theta: number; phi: number } = { theta: DEFAULT_THETA, phi: DEFAULT_PHI },
  margin = 1.1,
): CameraView {
  const halfVertical = (fovDegrees * Math.PI) / 360;
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * Math.max(1e-3, aspect));
  const halfAngle = Math.max(1e-3, Math.min(halfVertical, halfHorizontal));
  const radius = (margin * boundsDiagonal(bounds)) / 2 / Math.sin(halfAngle);
  return { theta: angles.theta, phi: angles.phi, radius, target: boundsCenter(bounds) };
}

export function zoomLimitsFor(bounds: Bounds): ZoomLimits {
  const diagonal = boundsDiagonal(bounds);
  return { min: diagonal * 0.05, max: diagonal * 20 };
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

export interface ResolvedColorScale {
  /** kelvin */
  min: number;
  max: number;
  map: ColormapId;
}

/** What is under the pointer, plus where the pointer is, for the floating readout. */
export interface HoverEvent {
  hit: PickHit | null;
  /** Client coordinates, in CSS pixels. */
  x: number;
  y: number;
}

export interface ThermalSceneHandlers {
  /** Fires at most once per animation frame while the pointer moves; null on leave. */
  onHover?(hover: HoverEvent | null): void;
  onSelectionChange?(selection: Target[], hit: PickHit | null): void;
  /** Fires on every gizmo drag step; the field the caller supplied is dropped as it moves. */
  onSectionPlaneChange?(plane: SectionPlane): void;
  /** Fires once the camera settles, not on every frame of a drag. */
  onCameraChange?(view: CameraView): void;
}

export interface ThermalSceneOptions {
  background?: number;
  fov?: number;
  maxPixelRatio?: number;
  handlers?: ThermalSceneHandlers;
}

/** Pointer travel below this on press-and-release is a click, not a drag. */
const CLICK_SLOP_PIXELS = 4;
const CAMERA_SETTLE_MS = 180;
const NO_DATA_LINEAR: readonly [number, number, number] = [
  srgbToLinear(((NO_DATA_COLOR >> 16) & 0xff) / 255),
  srgbToLinear(((NO_DATA_COLOR >> 8) & 0xff) / 255),
  srgbToLinear((NO_DATA_COLOR & 0xff) / 255),
];

type PointerMode = 'none' | 'orbit' | 'pan' | 'section';

export class ThermalScene {
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly raycaster = new THREE.Raycaster();
  private readonly lights: THREE.Light[] = [];
  private readonly background: number;
  private readonly maxPixelRatio: number;

  private readonly picker: Picker;
  private readonly overlays = new Overlays();
  private readonly gizmo: SectionGizmo;

  private handlers: ThermalSceneHandlers;

  private renderer: THREE.WebGLRenderer | null = null;
  private container: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private animationFrame = 0;
  private cameraSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private needsRender = true;
  private width = 1;
  private height = 1;

  private model: ThermalModel | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private mesh: THREE.Mesh | null = null;
  private partMaterials: THREE.MeshPhongMaterial[] = [];
  private colorAttribute: THREE.BufferAttribute | null = null;
  private colors = new Float32Array(0);
  private temperature: Float32Array | null = null;
  private scale: ResolvedColorScale = { min: 0, max: 1, map: 'inferno' };
  private wireframe: THREE.LineSegments | null = null;
  private wireframeVisible = false;
  private partOverrides: Record<string, PartOverride> = {};

  private view: CameraView = {
    theta: DEFAULT_THETA,
    phi: DEFAULT_PHI,
    radius: 3,
    target: [0, 0, 0],
  };
  private zoomLimits: ZoomLimits = { min: 0.05, max: 20 };
  /** True while the view is still the automatic framing, so a resize may re-frame. */
  private viewIsFramed = false;

  private pointerMode: PointerMode = 'none';
  private pointerId: number | null = null;
  private lastPointer = { x: 0, y: 0 };
  private pointerTravel = 0;
  private hoverPointer: { x: number; y: number } | null = null;

  constructor(options: ThermalSceneOptions = {}) {
    this.background = options.background ?? BACKGROUND_COLOR;
    this.maxPixelRatio = options.maxPixelRatio ?? 2;
    this.handlers = options.handlers ?? {};

    this.scene.background = new THREE.Color(this.background);
    this.camera = new THREE.PerspectiveCamera(options.fov ?? DEFAULT_FOV, 1, 0.001, 1000);
    this.camera.up.set(0, 0, 1);

    const ambient = new THREE.AmbientLight(0xffffff, 0.62);
    const key = new THREE.DirectionalLight(0xffffff, 0.55);
    key.position.set(-260, -380, 340).normalize();
    const fill = new THREE.DirectionalLight(0xffffff, 0.28);
    fill.position.set(320, 260, -160).normalize();
    this.lights.push(ambient, key, fill);
    this.scene.add(ambient, key, fill);

    this.picker = new Picker(this.camera);
    this.gizmo = new SectionGizmo({ onChange: (plane) => this.handleSectionChange(plane) });
    this.scene.add(this.picker.object, this.overlays.object, this.gizmo.object);
    this.picker.setFilter((partIndex, point) => this.isPickable(partIndex, point));
    this.applyView();
  }

  // -- lifecycle ------------------------------------------------------------

  mount(container: HTMLElement): void {
    if (this.renderer) throw new Error('ThermalScene is already mounted');
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.maxPixelRatio));
    renderer.setClearColor(this.background, 1);
    // Section clipping is per material, not global, so the gizmo itself stays whole.
    renderer.localClippingEnabled = true;

    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    // Without this the browser eats pointer events for scroll and pinch.
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);

    this.renderer = renderer;
    this.container = container;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.onContextMenu);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);
    this.handleResize();
    this.applyClipping();
    this.invalidate();
    this.animationFrame = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    if (this.cameraSettleTimer) clearTimeout(this.cameraSettleTimer);
    this.cameraSettleTimer = null;

    const canvas = this.renderer?.domElement;
    if (canvas) {
      canvas.removeEventListener('pointerdown', this.onPointerDown);
      canvas.removeEventListener('pointermove', this.onPointerMove);
      canvas.removeEventListener('pointerup', this.onPointerUp);
      canvas.removeEventListener('pointercancel', this.onPointerUp);
      canvas.removeEventListener('pointerleave', this.onPointerLeave);
      canvas.removeEventListener('wheel', this.onWheel);
      canvas.removeEventListener('contextmenu', this.onContextMenu);
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    // Order matters: these hold the mesh's position attribute and must let go of it
    // before the geometry that owns it is disposed.
    this.picker.dispose();
    this.overlays.dispose();
    this.gizmo.dispose();
    this.disposeModelObjects();

    for (const light of this.lights) light.dispose();
    this.lights.length = 0;
    this.scene.clear();

    const renderer = this.renderer;
    if (renderer) {
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    }
    this.renderer = null;
    this.container = null;
    this.model = null;
    this.temperature = null;
    this.handlers = {};
  }

  setHandlers(handlers: ThermalSceneHandlers): void {
    this.handlers = handlers;
  }

  /** Marks the frame dirty. Rendering is on demand, so external mutations need this. */
  invalidate(): void {
    this.needsRender = true;
  }

  // -- model and field ------------------------------------------------------

  setModel(model: ThermalModel | null): void {
    this.picker.setModel(null, null);
    this.overlays.setModel(null, null);
    this.disposeModelObjects();

    this.model = model;
    this.temperature = null;
    this.partOverrides = {};
    if (!model) {
      this.gizmo.setBounds(null);
      this.invalidate();
      return;
    }

    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(model.nodes, 3);
    geometry.setAttribute('position', position);
    geometry.setIndex(new THREE.BufferAttribute(model.tris, 1));
    this.colors = new Float32Array(model.nodeCount * 3);
    const colorAttribute = new THREE.BufferAttribute(this.colors, 3);
    colorAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('color', colorAttribute);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    this.partMaterials = (model.parts.length > 0 ? model.parts : [null]).map(() =>
      this.createPartMaterial(),
    );
    for (const group of triangleGroups(model, this.partMaterials.length)) {
      geometry.addGroup(group.start * 3, group.count * 3, group.materialIndex);
    }

    const mesh = new THREE.Mesh(geometry, this.partMaterials);
    mesh.name = 'thermal-mesh';
    this.scene.add(mesh);

    this.geometry = geometry;
    this.mesh = mesh;
    this.colorAttribute = colorAttribute;
    this.writeColors();
    if (this.wireframeVisible) this.buildWireframe();

    this.picker.setModel(model, mesh);
    this.overlays.setModel(model, position);
    this.gizmo.setBounds(model.bbox);
    this.applyClipping();
    this.resetView();
  }

  /**
   * Rewrites the colour attribute in place — no geometry is rebuilt — and returns
   * the concrete range the legend should show.
   */
  setTemperatures(
    temperature: Float32Array | null,
    scale: ColorScale,
    ambient: number,
  ): ResolvedColorScale {
    this.temperature = temperature;
    this.picker.setTemperatures(temperature);
    return this.setColorScale(scale, ambient);
  }

  /** The same repaint without a new field, for a colormap or range change. */
  setColorScale(scale: ColorScale, ambient: number): ResolvedColorScale {
    this.scale = this.resolveColorScale(scale, ambient);
    this.writeColors();
    this.invalidate();
    return this.scale;
  }

  /** Resolves `auto` / `ambientToMax` against the loaded field, without touching the view. */
  resolveColorScale(scale: ColorScale, ambient: number): ResolvedColorScale {
    const [min, max] = resolveScaleRange(scale, this.temperature, ambient);
    return { min, max, map: scale.map };
  }

  getColorScale(): ResolvedColorScale {
    return { ...this.scale };
  }

  getTemperatures(): Float32Array | null {
    return this.temperature;
  }

  getModel(): ThermalModel | null {
    return this.model;
  }

  /** Overlays and per-part visibility in one call; does not touch the colour scale. */
  setScenario(scenario: Scenario | null): void {
    this.overlays.setScenario(scenario);
    this.setPartOverrides(scenario?.partOverrides ?? {});
  }

  setPartOverrides(overrides: Record<string, PartOverride>): void {
    this.partOverrides = overrides;
    const model = this.model;
    if (!model) return;
    model.parts.forEach((part, index) => {
      const material = this.partMaterials[Math.min(index, this.partMaterials.length - 1)];
      if (!material) return;
      const override = overrides[part.id];
      const opacity = override?.opacity ?? 1;
      material.visible = override?.visible !== false;
      material.opacity = opacity;
      material.transparent = opacity < 1;
      material.depthWrite = opacity >= 1;
    });
    this.invalidate();
  }

  setWireframe(visible: boolean): void {
    this.wireframeVisible = visible;
    if (visible && !this.wireframe) this.buildWireframe();
    if (this.wireframe) this.wireframe.visible = visible;
    this.invalidate();
  }

  isWireframe(): boolean {
    return this.wireframeVisible;
  }

  // -- overlays -------------------------------------------------------------

  setOverlayVisible(kind: OverlayKind, visible: boolean): void {
    this.overlays.setVisible(kind, visible);
    this.invalidate();
  }

  isOverlayVisible(kind: OverlayKind): boolean {
    return this.overlays.isVisible(kind);
  }

  getOverlayVisibility(): Record<OverlayKind, boolean> {
    return this.overlays.getVisibility();
  }

  // -- selection ------------------------------------------------------------

  setSelectionMode(mode: SelectionMode): void {
    this.picker.setMode(mode);
    this.invalidate();
  }

  getSelectionMode(): SelectionMode {
    return this.picker.getMode();
  }

  setSelection(targets: readonly Target[]): void {
    this.picker.setSelection(targets);
    this.invalidate();
  }

  getSelection(): Target[] {
    return this.picker.getSelection();
  }

  clearSelection(): void {
    this.picker.clearSelection();
    this.invalidate();
  }

  /** Raw query at a client point, for the UI's own hit tests. No side effects. */
  pickAt(clientX: number, clientY: number): PickHit | null {
    const ndc = this.toNdc(clientX, clientY);
    return this.picker.pick(ndc.x, ndc.y, this.height);
  }

  // -- section --------------------------------------------------------------

  setSectionEnabled(enabled: boolean): void {
    this.gizmo.setEnabled(enabled);
    this.applyClipping();
  }

  isSectionEnabled(): boolean {
    return this.gizmo.isEnabled();
  }

  /** Whether the plane cuts the mesh away, or only marks where the cut is. */
  setSectionClipping(clipping: boolean): void {
    this.gizmo.setClipping(clipping);
    this.applyClipping();
  }

  isSectionClipping(): boolean {
    return this.gizmo.isClipping();
  }

  setSectionAxis(axis: SectionAxis, sign: 1 | -1 = 1): void {
    this.gizmo.setAxis(axis, sign);
  }

  setSectionPlane(plane: SectionPlane): void {
    this.gizmo.setPlane(plane);
  }

  getSectionPlane(): SectionPlane {
    return this.gizmo.getPlane();
  }

  /** The uv frame the plane's `SectionField2D` must be computed in. */
  getSectionBasis(): PlaneBasis {
    return this.gizmo.getBasis();
  }

  getSectionExtent(): PlaneExtent {
    return this.gizmo.getExtent();
  }

  setSectionOffset(offset: number): void {
    this.gizmo.setOffset(offset);
  }

  getSectionOffset(): number {
    return this.gizmo.getOffset();
  }

  getSectionOffsetRange(): { min: number; max: number } {
    return this.gizmo.getOffsetRange();
  }

  /** Draws a field the caller solved for the current plane. Null clears it. */
  setSectionField(field: SectionField2D | null, style?: SectionFieldStyle): void {
    this.gizmo.setField(field, style);
    this.invalidate();
  }

  // -- camera ---------------------------------------------------------------

  resetView(): void {
    const bounds = this.model?.bbox;
    if (!bounds) return;
    this.zoomLimits = zoomLimitsFor(bounds);
    this.view = frameBounds(bounds, this.camera.fov, this.width / this.height);
    this.updateCameraClipping(bounds);
    this.viewIsFramed = true;
    this.applyView();
    this.emitCameraChange();
  }

  getCameraView(): CameraView {
    return { ...this.view, target: [...this.view.target] as Vec3 };
  }

  setCameraView(view: CameraView): void {
    this.view = { ...view, target: [...view.target] as Vec3 };
    this.viewIsFramed = false;
    this.applyView();
  }

  // -- internals ------------------------------------------------------------

  private createPartMaterial(): THREE.MeshPhongMaterial {
    return new THREE.MeshPhongMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      shininess: 14,
      specular: 0x141414,
      flatShading: false,
      clippingPlanes: this.gizmo.getClippingPlanes(),
    });
  }

  private buildWireframe(): void {
    const geometry = this.geometry;
    if (!geometry || this.wireframe) return;
    const wireframe = new THREE.LineSegments(
      new THREE.WireframeGeometry(geometry),
      new THREE.LineBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.13,
        clippingPlanes: this.gizmo.getClippingPlanes(),
      }),
    );
    wireframe.name = 'wireframe';
    wireframe.visible = this.wireframeVisible;
    this.scene.add(wireframe);
    this.wireframe = wireframe;
  }

  /**
   * Non-finite temperatures — and nodes a short field never reached — are painted a
   * neutral grey rather than left at the bottom of the colour scale, so an
   * insulator part reads as "not solved" instead of as "cold".
   */
  private writeColors(): void {
    const model = this.model;
    const attribute = this.colorAttribute;
    if (!model || !attribute) return;
    const { min, max, map } = this.scale;
    const temperature = this.temperature;
    const nodeCount = model.nodeCount;
    const solved = temperature ? Math.min(nodeCount, temperature.length) : 0;

    if (temperature && solved > 0) {
      const values = solved === temperature.length ? temperature : temperature.subarray(0, solved);
      writeVertexColors(values, min, max, map, this.colors, { linear: true });
      for (let node = 0; node < solved; node++) {
        if (Number.isFinite(temperature[node])) continue;
        this.writeNoData(node);
      }
    }
    for (let node = solved; node < nodeCount; node++) this.writeNoData(node);
    attribute.needsUpdate = true;
  }

  private writeNoData(node: number): void {
    this.colors[node * 3] = NO_DATA_LINEAR[0];
    this.colors[node * 3 + 1] = NO_DATA_LINEAR[1];
    this.colors[node * 3 + 2] = NO_DATA_LINEAR[2];
  }

  private applyClipping(): void {
    const planes = this.gizmo.getClippingPlanes();
    for (const material of this.partMaterials) {
      material.clippingPlanes = planes;
      material.needsUpdate = true;
    }
    if (this.wireframe) {
      const material = this.wireframe.material as THREE.Material;
      material.clippingPlanes = planes;
      material.needsUpdate = true;
    }
    this.overlays.setClippingPlanes(planes);
    applyClippingPlanes(this.picker.object, planes);
    this.invalidate();
  }

  private isPickable(partIndex: number, point: THREE.Vector3): boolean {
    const part = this.model?.parts[partIndex];
    if (part && this.partOverrides[part.id]?.visible === false) return false;
    return this.gizmo.isPointVisible(point);
  }

  private updateCameraClipping(bounds: Bounds): void {
    const diagonal = boundsDiagonal(bounds);
    this.camera.near = Math.max(1e-5, diagonal * 0.002);
    this.camera.far = Math.max(1, diagonal * 60);
    this.camera.updateProjectionMatrix();
  }

  private applyView(): void {
    const [x, y, z] = orbitPosition(this.view);
    this.camera.position.set(x, y, z);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(this.view.target[0], this.view.target[1], this.view.target[2]);
    // Picking rays are built from matrixWorld, and a pick can land in the same frame
    // as a camera move, before the renderer would have refreshed it.
    this.camera.updateMatrixWorld();
    this.invalidate();
  }

  private handleSectionChange(plane: SectionPlane): void {
    this.invalidate();
    this.handlers.onSectionPlaneChange?.(plane);
  }

  private handleResize(): void {
    const container = this.container;
    const renderer = this.renderer;
    if (!container || !renderer) return;
    const width = Math.max(1, Math.floor(container.clientWidth));
    const height = Math.max(1, Math.floor(container.clientHeight));
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // A model loaded before the container had a size was framed for the wrong
    // aspect; re-frame until the user takes the camera over.
    if (this.viewIsFramed) this.resetView();
    this.invalidate();
  }

  private readonly tick = (): void => {
    this.animationFrame = requestAnimationFrame(this.tick);
    if (this.hoverPointer) this.runHover();
    if (!this.needsRender || !this.renderer) return;
    this.needsRender = false;
    this.renderer.render(this.scene, this.camera);
  };

  /** Hover is picked once per frame however fast the pointer moves. */
  private runHover(): void {
    const pointer = this.hoverPointer;
    this.hoverPointer = null;
    if (!pointer) return;
    const ndc = this.toNdc(pointer.x, pointer.y);
    const hit = this.picker.hover(ndc.x, ndc.y, this.height);
    this.invalidate();
    this.handlers.onHover?.({ hit, x: pointer.x, y: pointer.y });
  }

  private toNdc(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = this.renderer?.domElement;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.width > 0 ? ((clientX - rect.left) / rect.width) * 2 - 1 : 0,
      y: rect.height > 0 ? -((clientY - rect.top) / rect.height) * 2 + 1 : 0,
    };
  }

  private rayFrom(clientX: number, clientY: number): THREE.Raycaster {
    const ndc = this.toNdc(clientX, clientY);
    this.raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this.camera);
    return this.raycaster;
  }

  private emitCameraChange(): void {
    if (this.cameraSettleTimer) clearTimeout(this.cameraSettleTimer);
    this.cameraSettleTimer = setTimeout(() => {
      this.cameraSettleTimer = null;
      this.handlers.onCameraChange?.(this.getCameraView());
    }, CAMERA_SETTLE_MS);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    const canvas = this.renderer?.domElement;
    if (!canvas || this.pointerMode !== 'none') return;
    canvas.setPointerCapture(event.pointerId);
    this.pointerId = event.pointerId;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.pointerTravel = 0;
    this.hoverPointer = null;

    const wantsPan = event.button === 1 || event.button === 2 || event.shiftKey;
    if (
      !wantsPan &&
      event.button === 0 &&
      this.gizmo.beginDrag(this.rayFrom(event.clientX, event.clientY))
    ) {
      this.pointerMode = 'section';
      return;
    }
    this.pointerMode = wantsPan ? 'pan' : 'orbit';
    this.picker.clearHover();
    this.invalidate();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.pointerMode === 'none') {
      this.hoverPointer = { x: event.clientX, y: event.clientY };
      return;
    }
    if (this.pointerId !== null && event.pointerId !== this.pointerId) return;
    const dx = event.clientX - this.lastPointer.x;
    const dy = event.clientY - this.lastPointer.y;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.pointerTravel += Math.abs(dx) + Math.abs(dy);
    if (this.pointerMode !== 'section') this.viewIsFramed = false;

    switch (this.pointerMode) {
      case 'orbit':
        this.view = rotateView(this.view, dx, dy);
        this.applyView();
        break;
      case 'pan':
        this.view = panView(this.view, dx, dy, this.height, this.camera.fov);
        this.applyView();
        break;
      case 'section':
        this.gizmo.updateDrag(this.rayFrom(event.clientX, event.clientY));
        break;
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const canvas = this.renderer?.domElement;
    if (this.pointerId !== null && event.pointerId !== this.pointerId) return;
    if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);

    const mode = this.pointerMode;
    this.pointerMode = 'none';
    this.pointerId = null;
    this.gizmo.endDrag();

    // A press that barely moved is a click, whatever modifier was held — which is
    // what lets shift mean "pan" while dragging and "add to selection" on a click.
    if (mode !== 'section' && this.pointerTravel <= CLICK_SLOP_PIXELS && event.button === 0) {
      const hit = this.pickAt(event.clientX, event.clientY);
      const selection = this.picker.select(hit?.target ?? null, event.shiftKey);
      this.invalidate();
      this.handlers.onSelectionChange?.(selection, hit);
      return;
    }
    if (mode === 'orbit' || mode === 'pan') this.emitCameraChange();
  };

  private readonly onPointerLeave = (): void => {
    if (this.pointerMode !== 'none') return;
    this.hoverPointer = null;
    this.picker.clearHover();
    this.invalidate();
    this.handlers.onHover?.(null);
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.viewIsFramed = false;
    this.view = zoomView(this.view, event.deltaY, this.zoomLimits);
    this.applyView();
    this.emitCameraChange();
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    // Right-drag pans, so the browser menu has to stay out of the way.
    event.preventDefault();
  };

  private disposeModelObjects(): void {
    if (this.mesh) this.scene.remove(this.mesh);
    if (this.wireframe) {
      this.scene.remove(this.wireframe);
      this.wireframe.geometry.dispose();
      (this.wireframe.material as THREE.Material).dispose();
      this.wireframe = null;
    }
    this.geometry?.dispose();
    for (const material of this.partMaterials) material.dispose();
    this.partMaterials = [];
    this.geometry = null;
    this.mesh = null;
    this.colorAttribute = null;
    this.colors = new Float32Array(0);
  }
}

export interface TriangleGroup {
  /** Triangle index, not element index. */
  start: number;
  count: number;
  materialIndex: number;
}

/**
 * Contiguous runs of triangles belonging to one part, as draw groups. Built from
 * `triPart` rather than `Part.triRange` so a model whose parts interleave still
 * draws every triangle exactly once.
 */
export function triangleGroups(model: ThermalModel, materialCount: number): TriangleGroup[] {
  const groups: TriangleGroup[] = [];
  if (model.triCount === 0 || materialCount === 0) return groups;
  const last = materialCount - 1;
  let start = 0;
  for (let tri = 1; tri <= model.triCount; tri++) {
    if (tri < model.triCount && model.triPart[tri] === model.triPart[start]) continue;
    groups.push({
      start,
      count: tri - start,
      materialIndex: Math.min(model.triPart[start], last),
    });
    start = tri;
  }
  return groups;
}

function applyClippingPlanes(root: THREE.Object3D, planes: THREE.Plane[] | null): void {
  root.traverse((object) => {
    const material = (object as Partial<THREE.Mesh>).material;
    if (!material) return;
    for (const single of Array.isArray(material) ? material : [material]) {
      single.clippingPlanes = planes;
      single.needsUpdate = true;
    }
  });
}
