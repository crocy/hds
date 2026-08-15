/**
 * Toggleable overlays that draw what the *scenario* claims about the model:
 * contact patches, fixed-temperature boundaries, heat loads, cavity-facing faces
 * and feature edges.
 *
 * This is how the user checks auto-detection. A contact patch on the wrong pair
 * of faces or a cavity that swallowed an outside surface is invisible in a shaded
 * temperature field and obvious here, so the markers are drawn bright and their
 * points and lines ignore depth — a patch buried inside a closed housing still
 * shows through the shell.
 *
 * Selection and hover live in `picking.ts` instead, and neither layer touches the
 * mesh colour attribute: that belongs to the temperature field alone.
 *
 * Everything above the `Overlays` class is pure index maths over a ThermalModel,
 * so it is unit-testable without a renderer.
 */

import * as THREE from 'three';
import type { BoundaryCondition, Contact, Scenario, ThermalModel } from '@/core/types';
import { partIndexOf, resolveTarget } from './picking';

export type OverlayKind = 'contacts' | 'fixedTemp' | 'heatLoad' | 'cavities' | 'featureEdges';

export const OVERLAY_KINDS: readonly OverlayKind[] = [
  'contacts',
  'fixedTemp',
  'heatLoad',
  'cavities',
  'featureEdges',
];

/**
 * Chosen to stay legible against inferno's black→purple→yellow ramp and against
 * each other — the legend the UI builds from these is only useful if two overlays
 * can never be confused on the mesh.
 */
export const OVERLAY_COLORS: Record<OverlayKind, number> = {
  contacts: 0xff3cc8,
  fixedTemp: 0x00ffd5,
  heatLoad: 0x9dff2e,
  cavities: 0xa46bff,
  featureEdges: 0x9fb0d0,
};

export const OVERLAY_LABELS: Record<OverlayKind, string> = {
  contacts: 'contact patches',
  fixedTemp: 'fixed temperature',
  heatLoad: 'heat load',
  cavities: 'cavity-facing faces',
  featureEdges: 'feature edges',
};

// ---------------------------------------------------------------------------
// Pure geometry selection
// ---------------------------------------------------------------------------

/** Every node named by a contact, deduplicated. */
export function contactNodes(contact: Contact): Uint32Array {
  return Uint32Array.from(new Set(contact.nodePairs));
}

/**
 * Triangles of either contacting part with at least one whole edge inside the
 * patch. Requiring two nodes rather than one keeps a single stray paired node
 * from lighting up its entire vertex star and overstating the patch.
 */
export function contactPatchTriangles(model: ThermalModel, contact: Contact): Uint32Array {
  const nodes = new Set<number>(contact.nodePairs);
  const triangles: number[] = [];
  for (const partId of [contact.partA, contact.partB]) {
    const partIndex = partIndexOf(model, partId);
    if (partIndex < 0) continue;
    const [start, end] = model.parts[partIndex].triRange;
    for (let t = start; t < end; t++) {
      let hits = 0;
      if (nodes.has(model.tris[t * 3])) hits++;
      if (nodes.has(model.tris[t * 3 + 1])) hits++;
      if (nodes.has(model.tris[t * 3 + 2])) hits++;
      if (hits >= 2) triangles.push(t);
    }
  }
  return Uint32Array.from(triangles);
}

/** Inside-facing triangles: one cavity, or every cavity when `cavityId` is omitted. */
export function cavityFaceTriangles(model: ThermalModel, cavityId?: number): Uint32Array {
  const triangles: number[] = [];
  for (let t = 0; t < model.triCount; t++) {
    const cavity = model.triCavity[t];
    if (cavity === 0) continue;
    if (cavityId !== undefined && cavity !== cavityId) continue;
    triangles.push(t);
  }
  return Uint32Array.from(triangles);
}

interface TargetGeometry {
  triangles: number[];
  paths: ArrayLike<number>[];
  nodes: number[];
}

/** Union of the targets of every enabled boundary condition of one kind. */
export function boundaryConditionGeometry(
  model: ThermalModel,
  conditions: readonly BoundaryCondition[],
  kind: BoundaryCondition['kind'],
): TargetGeometry {
  const out: TargetGeometry = { triangles: [], paths: [], nodes: [] };
  for (const condition of conditions) {
    if (condition.kind !== kind || !condition.enabled) continue;
    const resolved = resolveTarget(model, condition.target);
    for (const tri of resolved.triangles) out.triangles.push(tri);
    if (condition.target.type === 'edge') out.paths.push(resolved.nodes);
    for (const node of resolved.nodes) out.nodes.push(node);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Draw layer
// ---------------------------------------------------------------------------

interface LayerStyle {
  color: number;
  faceOpacity: number;
  lineOpacity: number;
  lineWidth: number;
  pointSize: number;
  /** Points and lines draw through the shell, so a marker inside a housing is still found. */
  markersThroughSurface: boolean;
}

const OVERLAY_STYLES: Record<OverlayKind, LayerStyle> = {
  contacts: {
    color: OVERLAY_COLORS.contacts,
    faceOpacity: 0.55,
    lineOpacity: 0.9,
    lineWidth: 1,
    pointSize: 7,
    markersThroughSurface: true,
  },
  fixedTemp: {
    color: OVERLAY_COLORS.fixedTemp,
    faceOpacity: 0.45,
    lineOpacity: 0.95,
    lineWidth: 1,
    pointSize: 8,
    markersThroughSurface: true,
  },
  heatLoad: {
    color: OVERLAY_COLORS.heatLoad,
    faceOpacity: 0.45,
    lineOpacity: 0.95,
    lineWidth: 1,
    pointSize: 8,
    markersThroughSurface: true,
  },
  cavities: {
    color: OVERLAY_COLORS.cavities,
    faceOpacity: 0.4,
    lineOpacity: 0.6,
    lineWidth: 1,
    pointSize: 4,
    markersThroughSurface: false,
  },
  featureEdges: {
    color: OVERLAY_COLORS.featureEdges,
    faceOpacity: 0.25,
    lineOpacity: 0.4,
    lineWidth: 1,
    pointSize: 3,
    markersThroughSurface: false,
  },
};

/**
 * Faces, polylines and points in one colour, all indexing the mesh's own position
 * buffer so nothing is copied and the overlay can never drift from the geometry.
 */
class MarkerLayer {
  readonly group = new THREE.Group();
  private readonly faces: THREE.Mesh;
  private readonly lines: THREE.LineSegments;
  private readonly points: THREE.Points;
  private readonly faceGeometry = new THREE.BufferGeometry();
  private readonly lineGeometry = new THREE.BufferGeometry();
  private readonly pointGeometry = new THREE.BufferGeometry();

  constructor(style: LayerStyle) {
    const faceMaterial = new THREE.MeshBasicMaterial({
      color: style.color,
      transparent: true,
      opacity: style.faceOpacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
      toneMapped: false,
    });
    const lineMaterial = new THREE.LineBasicMaterial({
      color: style.color,
      transparent: true,
      opacity: style.lineOpacity,
      linewidth: style.lineWidth,
      depthTest: !style.markersThroughSurface,
      toneMapped: false,
    });
    const pointMaterial = new THREE.PointsMaterial({
      color: style.color,
      size: style.pointSize,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.95,
      depthTest: !style.markersThroughSurface,
      toneMapped: false,
    });

    this.faces = new THREE.Mesh(this.faceGeometry, faceMaterial);
    this.lines = new THREE.LineSegments(this.lineGeometry, lineMaterial);
    this.points = new THREE.Points(this.pointGeometry, pointMaterial);
    for (const object of [this.faces, this.lines, this.points]) {
      object.renderOrder = 2;
      object.frustumCulled = false;
      object.visible = false;
      this.group.add(object);
    }
  }

  get materials(): THREE.Material[] {
    return [this.faces, this.lines, this.points].map((object) => object.material as THREE.Material);
  }

  setPositionSource(attribute: THREE.BufferAttribute | null): void {
    for (const geometry of [this.faceGeometry, this.lineGeometry, this.pointGeometry]) {
      if (attribute) geometry.setAttribute('position', attribute);
      else geometry.deleteAttribute('position');
    }
  }

  setTriangles(model: ThermalModel, triangles: ArrayLike<number>): void {
    if (triangles.length === 0) {
      this.faces.visible = false;
      return;
    }
    const indices = new Uint32Array(triangles.length * 3);
    for (let i = 0; i < triangles.length; i++) {
      const t = triangles[i];
      indices[i * 3] = model.tris[t * 3];
      indices[i * 3 + 1] = model.tris[t * 3 + 1];
      indices[i * 3 + 2] = model.tris[t * 3 + 2];
    }
    this.faceGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.faceGeometry.setDrawRange(0, indices.length);
    this.faces.visible = true;
  }

  /** `paths` are node-index runs; consecutive pairs become segments. */
  setPaths(paths: readonly ArrayLike<number>[]): void {
    let count = 0;
    for (const path of paths) count += Math.max(0, path.length - 1) * 2;
    if (count === 0) {
      this.lines.visible = false;
      return;
    }
    const indices = new Uint32Array(count);
    let cursor = 0;
    for (const path of paths) {
      for (let i = 0; i + 1 < path.length; i++) {
        indices[cursor++] = path[i];
        indices[cursor++] = path[i + 1];
      }
    }
    this.lineGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.lineGeometry.setDrawRange(0, count);
    this.lines.visible = true;
  }

  setNodes(nodes: ArrayLike<number>): void {
    if (nodes.length === 0) {
      this.points.visible = false;
      return;
    }
    const indices = Uint32Array.from(nodes);
    this.pointGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.pointGeometry.setDrawRange(0, indices.length);
    this.points.visible = true;
  }

  clear(): void {
    this.faces.visible = false;
    this.lines.visible = false;
    this.points.visible = false;
  }

  setClippingPlanes(planes: THREE.Plane[] | null): void {
    for (const material of this.materials) {
      material.clippingPlanes = planes;
      material.needsUpdate = true;
    }
  }

  dispose(): void {
    // The position attribute belongs to the mesh; drop it before disposing these
    // geometries or the shared GPU buffer goes with them.
    this.setPositionSource(null);
    for (const geometry of [this.faceGeometry, this.lineGeometry, this.pointGeometry]) {
      geometry.dispose();
    }
    for (const material of this.materials) material.dispose();
    this.group.clear();
  }
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

export class Overlays {
  readonly object = new THREE.Group();

  private readonly layers = new Map<OverlayKind, MarkerLayer>();
  private readonly visible = new Map<OverlayKind, boolean>();
  private readonly stale = new Set<OverlayKind>(OVERLAY_KINDS);

  private model: ThermalModel | null = null;
  private scenario: Scenario | null = null;
  private clippingPlanes: THREE.Plane[] | null = null;
  private lastContacts: readonly Contact[] | null = null;
  private lastConditions: readonly BoundaryCondition[] | null = null;

  constructor() {
    this.object.name = 'overlays';
    for (const kind of OVERLAY_KINDS) {
      const layer = new MarkerLayer(OVERLAY_STYLES[kind]);
      layer.group.name = `overlay-${kind}`;
      layer.group.visible = false;
      this.layers.set(kind, layer);
      this.visible.set(kind, false);
      this.object.add(layer.group);
    }
  }

  setModel(model: ThermalModel | null, positions: THREE.BufferAttribute | null): void {
    this.model = model;
    this.lastContacts = null;
    this.lastConditions = null;
    for (const [kind, layer] of this.layers) {
      layer.clear();
      layer.setPositionSource(positions);
      this.stale.add(kind);
    }
    this.rebuildVisible();
  }

  /** Rebuilds only the layers whose backing arrays actually changed identity. */
  setScenario(scenario: Scenario | null): void {
    this.scenario = scenario;
    const contacts = scenario?.contacts ?? null;
    const conditions = scenario?.boundaryConditions ?? null;
    if (contacts !== this.lastContacts) {
      this.lastContacts = contacts;
      this.stale.add('contacts');
    }
    if (conditions !== this.lastConditions) {
      this.lastConditions = conditions;
      this.stale.add('fixedTemp');
      this.stale.add('heatLoad');
    }
    this.rebuildVisible();
  }

  setVisible(kind: OverlayKind, visible: boolean): void {
    this.visible.set(kind, visible);
    const layer = this.layers.get(kind);
    if (!layer) return;
    if (visible && this.stale.has(kind)) this.rebuild(kind);
    layer.group.visible = visible;
  }

  isVisible(kind: OverlayKind): boolean {
    return this.visible.get(kind) === true;
  }

  getVisibility(): Record<OverlayKind, boolean> {
    const out = {} as Record<OverlayKind, boolean>;
    for (const kind of OVERLAY_KINDS) out[kind] = this.isVisible(kind);
    return out;
  }

  setClippingPlanes(planes: THREE.Plane[] | null): void {
    this.clippingPlanes = planes;
    for (const layer of this.layers.values()) layer.setClippingPlanes(planes);
  }

  dispose(): void {
    for (const layer of this.layers.values()) layer.dispose();
    this.layers.clear();
    this.object.clear();
    this.model = null;
    this.scenario = null;
  }

  private rebuildVisible(): void {
    for (const kind of OVERLAY_KINDS) {
      if (this.isVisible(kind) && this.stale.has(kind)) this.rebuild(kind);
    }
  }

  private rebuild(kind: OverlayKind): void {
    const layer = this.layers.get(kind);
    if (!layer) return;
    this.stale.delete(kind);
    layer.clear();
    layer.setClippingPlanes(this.clippingPlanes);

    const model = this.model;
    if (!model) return;

    switch (kind) {
      case 'contacts': {
        const triangles: number[] = [];
        const nodes: number[] = [];
        for (const contact of this.scenario?.contacts ?? []) {
          if (!contact.enabled) continue;
          for (const tri of contactPatchTriangles(model, contact)) triangles.push(tri);
          for (const node of contactNodes(contact)) nodes.push(node);
        }
        layer.setTriangles(model, triangles);
        layer.setNodes(nodes);
        break;
      }
      case 'fixedTemp':
      case 'heatLoad': {
        const conditions = this.scenario?.boundaryConditions ?? [];
        const geometry = boundaryConditionGeometry(
          model,
          conditions,
          kind === 'fixedTemp' ? 'fixedTemp' : 'heatLoad',
        );
        layer.setTriangles(model, geometry.triangles);
        layer.setPaths(geometry.paths);
        // Faces already read as a patch; drawing every node of a whole part on top
        // would just be a fog of dots, so points mark the small targets only.
        layer.setNodes(geometry.triangles.length > 0 ? [] : geometry.nodes);
        break;
      }
      case 'cavities': {
        layer.setTriangles(model, cavityFaceTriangles(model));
        break;
      }
      case 'featureEdges': {
        layer.setPaths(model.featureEdges.map((chain) => chain.nodes));
        break;
      }
    }
  }
}
