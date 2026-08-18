/**
 * ThermalModel + Scenario → the linear system.
 *
 * Everything model-aware lives here: the DOF map (the one place `bodyType` is
 * special-cased), target resolution, cotangent conduction weights, surface exchange,
 * contacts, loads, and fixed-temperature elimination. Convection and radiation are
 * pure correlations in their own modules; this file decides where they apply.
 */

import type { Cavity, Part, Scenario, Target, ThermalModel } from '../core/types';
import { buildBvh, createHitBuffer, raycastInto, type Bvh, type HitBuffer } from '../geometry/bvh';
import { buildVolumeMesh, type VolumeMesh } from '../geometry/volume';
import { computeConvectionCoefficients } from './convection';
import { resolvePart } from './materials';
import { computeTriangleEmissivity, radiationCoefficient } from './radiation';
import { CsrMatrix, SparseBuilder } from './sparse';

const NO_NODES = new Uint32Array(0);

/**
 * Cells across a solid part's thickness. The resistance through a wall is exact at any
 * count — a series of cells sums to the same `t/(k·A)` — so this buys resolution of the
 * field and of the half-cell offset at the boundary, not the total.
 */
const CELLS_ACROSS_THICKNESS = 4;

/** A `solid` part's interior cells, and where their DOFs start. */
export interface VolumeDofs {
  mesh: VolumeMesh;
  /** DOF of cell c is `dofBase + c`. */
  dofBase: number;
}

export interface DofMap {
  /** node → degree of freedom, −1 for nodes excluded from the system. */
  nodeDof: Int32Array;
  /** dof → owning part index, node DOFs only. DOFs never span parts. */
  dofPart: Int32Array;
  /** DOF of each cavity's trapped air, indexed by cavity id. −1 for adiabatic or absent. */
  cavityDof: Int32Array;
  /** One entry per part actually solved volumetrically; empty when none is. */
  volumes: VolumeDofs[];
  /**
   * Everything a node temperature may refer to occupies 0..nodeDofCount — the volume
   * cells first, then the node DOFs proper. Cavity air follows, and nothing reads it
   * as a node.
   */
  nodeDofCount: number;
  dofCount: number;
  /** Complaints raised while building the map, for the solver to surface. */
  warnings: string[];
}

/** Parts whose in-plane shell conduction is replaced by their interior. */
export function volumetricParts(dofs: DofMap): Set<number> {
  return new Set(dofs.volumes.map((volume) => volume.mesh.partIndex));
}

/**
 * A `sheet` node gets its own DOF, except that the two nodes facing each other across a
 * sheet solid's thickness share one (see `pairThroughThickness`); every node of a
 * `lump` shares one, which makes the part internally isothermal while it still
 * exchanges heat over its full area; an `insulator` gets −1 and drops out of the system
 * entirely.
 *
 * A `solid` node gets its own DOF too, but its part conducts through the cells filling
 * it rather than along its skin, so the surface is a boundary the interior reaches
 * rather than a path in its own right.
 */
export function buildDofMap(model: ThermalModel, scenario: Scenario): DofMap {
  const nodeDof = new Int32Array(model.nodeCount).fill(-1);
  const bodyTypes = model.parts.map(
    (part) => resolvePart(part, scenario.partOverrides[part.id]).bodyType,
  );
  const lumpDof = new Int32Array(model.parts.length).fill(-1);
  const opposite = pairThroughThickness(model, scenario);
  const dofPart: number[] = [];
  const warnings: string[] = [];

  // Cells are numbered first, because a filled part's surface nodes take their DOFs
  // from them rather than owning any of their own.
  const volumes = buildVolumeDofs(model, scenario, bodyTypes, 0, warnings);
  const volumeOf = new Map(volumes.volumes.map((volume) => [volume.mesh.partIndex, volume]));
  let dofCount = volumes.dofCount;
  for (let dof = 0; dof < dofCount; dof++) dofPart.push(-1);
  for (const volume of volumes.volumes) {
    for (let cell = 0; cell < volume.mesh.cellCount; cell++) {
      dofPart[volume.dofBase + cell] = volume.mesh.partIndex;
    }
  }

  let strandedNodes = 0;
  for (let node = 0; node < model.nodeCount; node++) {
    const part = model.nodePart[node];
    const bodyType = bodyTypes[part] ?? 'sheet';
    if (bodyType === 'insulator') continue;
    if (volumeOf.has(part)) {
      // A filled part's node keeps a DOF of its own — it is the temperature *at the
      // surface*, where the film, the radiation and any contact act — and reaches the
      // interior through the single cell behind it. One link per node, never one cell
      // to many nodes: a cell tied to the corners of a coarse facet would put every
      // cell under that facet on a common temperature, which is the short along the
      // skin that filling the part exists to remove.
      if (volumeOf.get(part)!.mesh.nodeCell[node] < 0) strandedNodes++;
      nodeDof[node] = dofCount++;
      dofPart.push(part);
      continue;
    }
    if (bodyType === 'lump') {
      if (lumpDof[part] < 0) {
        lumpDof[part] = dofCount++;
        dofPart.push(part);
      }
      nodeDof[node] = lumpDof[part];
      continue;
    }
    // One DOF for the two faces of the sheet. Each half-thickness shell still
    // contributes its own cotangent weights, now to the same equations, so in plane
    // they sum back to the full thickness; each node keeps its own area and its own
    // cavity-or-open-air condition, so the two faces go on exchanging heat with
    // different environments; and the pair is isothermal through the sheet, which is
    // what Bi = h·t/k ≈ 5e-4 means physically.
    const twin = opposite[node];
    if (twin >= 0 && nodeDof[twin] >= 0) {
      nodeDof[node] = nodeDof[twin];
      continue;
    }
    nodeDof[node] = dofCount++;
    dofPart.push(part);
  }

  if (strandedNodes > 0) {
    warnings.push(
      `${strandedNodes} node(s) of a solid part found no cell behind them — the wall there is ` +
        `thinner than the grid — so that much of its surface reaches the interior through its ` +
        `neighbours only`,
    );
  }

  const cavities = assignCavityDofs(scenario.cavities, dofCount);
  return {
    nodeDof,
    dofPart: Int32Array.from(dofPart),
    cavityDof: cavities.cavityDof,
    volumes: volumes.volumes,
    warnings,
    nodeDofCount: dofCount,
    dofCount: cavities.dofCount,
  };
}

/**
 * Cells for every `solid` part, numbered after the cavity air.
 *
 * A part that yields none — an open shell, or a wall the grid could not resolve — is
 * reported and left to conduct in plane as a sheet would. Zeroing its shell conduction
 * on the strength of an interior that is not there would disconnect it entirely, and
 * an isolated part pinned to ambient is a far worse answer than a coarse one.
 */
function buildVolumeDofs(
  model: ThermalModel,
  scenario: Scenario,
  bodyTypes: readonly string[],
  firstDof: number,
  warnings: string[],
): { volumes: VolumeDofs[]; dofCount: number } {
  const volumes: VolumeDofs[] = [];
  let dofCount = firstDof;
  if (!bodyTypes.includes('solid')) return { volumes, dofCount };

  const bvh = buildBvh(model);
  model.parts.forEach((part, index) => {
    if (bodyTypes[index] !== 'solid') return;
    // The resolved thickness, so the grid follows the figure the user can actually
    // edit rather than whatever import derived from volume over surface area.
    const { thickness } = resolvePart(part, scenario.partOverrides[part.id]);
    const mesh = buildVolumeMesh(model, index, { bvh, cellSize: thickness / CELLS_ACROSS_THICKNESS });
    if (mesh.cellCount === 0) {
      warnings.push(
        `'${part.name}' is set to solid but no interior could be filled — its shell is not ` +
          `closed, or its wall is thinner than one cell. It was conducted as a sheet instead`,
      );
      return;
    }
    if (mesh.coarsened) {
      warnings.push(
        `'${part.name}' needed a coarser grid than its thickness asked for ` +
          `(${(mesh.cellSize * 1000).toFixed(1)} mm cells); its gradient is under-resolved`,
      );
    }
    volumes.push({ mesh, dofBase: dofCount });
    dofCount += mesh.cellCount;
  });
  return { volumes, dofCount };
}

/**
 * One DOF for the air in each **live** cavity — one whose condition is not `adiabatic` —
 * numbered from `firstDof`, so everything that walks the solution vector as nodes can
 * stop before them.
 *
 * An adiabatic cavity exchanges nothing at all: `h = 0` and `ε = 0` would leave its row
 * empty and the matrix singular, and the isolated-DOF rescue that catches that would
 * report it as a modelling mistake when it is exactly what the user asked for.
 */
function assignCavityDofs(
  cavities: Cavity[],
  firstDof: number,
): { cavityDof: Int32Array; dofCount: number } {
  // Indexed by cavity id, so ids naming no cavity — 0 above all, which marks open air —
  // read −1 like adiabatic ones do.
  let maxId = 0;
  for (const cavity of cavities) maxId = Math.max(maxId, cavity.id);
  const cavityDof = new Int32Array(maxId + 1).fill(-1);

  let dofCount = firstDof;
  for (const cavity of cavities) {
    if (cavity.condition === 'adiabatic') continue;
    cavityDof[cavity.id] = dofCount++;
  }
  return { cavityDof, dofCount };
}

/**
 * How far from the nominal thickness an opposite-face hit may land, as a fraction of
 * it. Wide enough for a typed thickness to disagree with the CAD, and for the longer
 * slant a node's averaged normal takes across a bend; narrow enough that the far wall
 * of a housing is never mistaken for the far face of this one.
 */
const THICKNESS_TOLERANCE = 0.5;

/**
 * How squarely the far triangle has to face back, as a normal-vs-normal cosine. The two
 * faces of a flat sheet score −1; an edge band or a fillet runs across the face it
 * borders and scores near 0, which is what this rejects.
 */
const OPPOSING_NORMAL_COSINE = -0.5;

/**
 * How far, in units of the sheet thickness, the hit may land from the node it is
 * matched to. "The same in-plane position" is the whole point of the pairing — a match
 * further off than the wall is thick would be shifting heat sideways, not through.
 */
const IN_PLANE_TOLERANCE = 1;

/**
 * node → the node directly opposite it through the sheet, or −1 where there is none.
 *
 * A CAD sheet part is a solid, so its mesh carries both of its faces. Conducting
 * through `thickness/2` per face gives the two shells in parallel the right total
 * conduction in plane, but on its own it leaves them joined only around the edge bands.
 * That is exact while both faces see the same environment — symmetry puts no flux
 * across the mid-plane — and wrong as soon as one face is a cavity wall and the other
 * open air, which is the normal case for a housing: the inner skin becomes a
 * near-lossless heat spreader. A real sheet cannot do that. Bi = h·t/k across 1 mm of
 * steel under natural convection is ~5e-4, so it is isothermal through its thickness,
 * and merging the two nodes onto one DOF is how that is said.
 *
 * The match is found by casting a ray inward from each node and taking the hit on the
 * same part at about the sheet's thickness whose triangle faces back. A pair is kept
 * only when both nodes choose each other, which makes the result a perfect matching:
 * nothing is merged twice and no chain of three can form. Edge bands, holes and
 * anything else that does not pair cleanly is left alone — falling back to the two
 * shells joined at their rims is the previous, still-defensible behaviour, not a
 * failure.
 */
export function pairThroughThickness(model: ThermalModel, scenario: Scenario): Int32Array {
  const partner = new Int32Array(model.nodeCount).fill(-1);

  // Only a closed solid carries both faces; an open shell is a genuine mid-surface mesh
  // with nothing to pair to. Lumps are already one DOF and insulators have none.
  const thickness = new Float64Array(model.parts.length);
  let anyPairable = false;
  model.parts.forEach((part, index) => {
    const resolved = resolvePart(part, scenario.partOverrides[part.id]);
    if (resolved.bodyType !== 'sheet' || part.volume === 0 || !(resolved.thickness > 0)) return;
    thickness[index] = resolved.thickness;
    anyPairable = true;
  });
  if (!anyPairable) return partner;

  const normals = nodeNormals(model, thickness);
  const bvh = buildBvh(model);
  const hits = createHitBuffer();
  const candidate = new Int32Array(model.nodeCount).fill(-1);

  for (let node = 0; node < model.nodeCount; node++) {
    if (!(thickness[model.nodePart[node]] > 0)) continue;
    candidate[node] = oppositeNode(model, bvh, hits, normals, thickness, node);
  }

  for (let node = 0; node < model.nodeCount; node++) {
    const twin = candidate[node];
    if (twin > node && candidate[twin] === node) {
      partner[node] = twin;
      partner[twin] = node;
    }
  }
  return partner;
}

/** Area-weighted vertex normals, computed only for the parts that can pair. */
function nodeNormals(model: ThermalModel, thickness: Float64Array): Float64Array {
  const normals = new Float64Array(model.nodeCount * 3);
  for (let t = 0; t < model.triCount; t++) {
    if (!(thickness[model.triPart[t]] > 0)) continue;
    const area = model.triArea[t];
    for (let c = 0; c < 3; c++) {
      const node = model.tris[t * 3 + c] * 3;
      normals[node] += model.triNormal[t * 3] * area;
      normals[node + 1] += model.triNormal[t * 3 + 1] * area;
      normals[node + 2] += model.triNormal[t * 3 + 2] * area;
    }
  }
  return normals;
}

// Query scratch. Like the BVH's own, these rely on pairing being single-threaded and
// never nested.
const rayOrigin = new Float64Array(3);
const rayDirection = new Float64Array(3);

function oppositeNode(
  model: ThermalModel,
  bvh: Bvh,
  hits: HitBuffer,
  normals: Float64Array,
  thickness: Float64Array,
  node: number,
): number {
  const nx = normals[node * 3];
  const ny = normals[node * 3 + 1];
  const nz = normals[node * 3 + 2];
  const length = Math.hypot(nx, ny, nz);
  // A node whose incident normals cancel — a crease seen from both sides — has no
  // inward direction to cast along.
  if (!(length > 0)) return -1;

  const wall = thickness[model.nodePart[node]];
  rayOrigin[0] = model.nodes[node * 3];
  rayOrigin[1] = model.nodes[node * 3 + 1];
  rayOrigin[2] = model.nodes[node * 3 + 2];
  rayDirection[0] = -nx / length;
  rayDirection[1] = -ny / length;
  rayDirection[2] = -nz / length;

  raycastInto(bvh, rayOrigin, rayDirection, hits, {
    minDistance: wall * (1 - THICKNESS_TOLERANCE),
    maxDistance: wall * (1 + THICKNESS_TOLERANCE),
  });

  const part = model.nodePart[node];
  let best = -1;
  let bestError = Infinity;
  for (let i = 0; i < hits.count; i++) {
    const triangle = hits.triangles[i];
    if (model.triPart[triangle] !== part) continue;
    const facing =
      (model.triNormal[triangle * 3] * nx +
        model.triNormal[triangle * 3 + 1] * ny +
        model.triNormal[triangle * 3 + 2] * nz) /
      length;
    if (!(facing <= OPPOSING_NORMAL_COSINE)) continue;

    const error = Math.abs(hits.distances[i] - wall);
    if (error >= bestError) continue;
    const corner = nearestCorner(model, triangle, hits.distances[i], wall * IN_PLANE_TOLERANCE);
    if (corner < 0 || corner === node) continue;
    best = corner;
    bestError = error;
  }
  return best;
}

/**
 * The hit triangle's corner nearest where the ray landed, or −1 when even the nearest
 * one is further off in plane than `limit`.
 */
function nearestCorner(
  model: ThermalModel,
  triangle: number,
  distance: number,
  limit: number,
): number {
  const hx = rayOrigin[0] + rayDirection[0] * distance;
  const hy = rayOrigin[1] + rayDirection[1] * distance;
  const hz = rayOrigin[2] + rayDirection[2] * distance;

  let best = -1;
  let bestOffset = limit;
  for (let c = 0; c < 3; c++) {
    const corner = model.tris[triangle * 3 + c];
    const offset = Math.hypot(
      model.nodes[corner * 3] - hx,
      model.nodes[corner * 3 + 1] - hy,
      model.nodes[corner * 3 + 2] - hz,
    );
    if (offset > bestOffset) continue;
    best = corner;
    bestOffset = offset;
  }
  return best;
}

/**
 * The thickness one triangle of `part` conducts through, metres.
 *
 * `Part.thickness` is the physical sheet thickness — what a drawing quotes and a user
 * types. A CAD sheet-metal part is a *solid*, so its tessellation is a closed shell
 * carrying both faces of the sheet plus the edge bands, and giving every triangle the
 * full thickness would conduct through 2·t. Half each: two parallel shells of t/2
 * joined around the edge bands conduct exactly t, and convect from both faces, which
 * is what the real sheet does.
 *
 * An open shell (`volume === 0`) is a genuine mid-surface mesh — one shell, full
 * thickness. Surface area is never halved: both faces really are exposed.
 */
export function conductionThickness(part: Part, thickness: number): number {
  return part.volume === 0 ? thickness : thickness / 2;
}

export function partIndexOf(model: ThermalModel, partId: string): number {
  return model.parts.findIndex((part) => part.id === partId);
}

/** A `Target` names a node set; every boundary condition is applied through one. */
export function resolveTargetNodes(model: ThermalModel, target: Target): Uint32Array {
  const partIndex = partIndexOf(model, target.partId);
  if (partIndex < 0) return NO_NODES;

  switch (target.type) {
    case 'part': {
      const nodes: number[] = [];
      for (let node = 0; node < model.nodeCount; node++) {
        if (model.nodePart[node] === partIndex) nodes.push(node);
      }
      return Uint32Array.from(nodes);
    }
    case 'face': {
      const seen = new Uint8Array(model.nodeCount);
      const nodes: number[] = [];
      for (let t = 0; t < model.triCount; t++) {
        if (model.triPart[t] !== partIndex || model.triFace[t] !== target.faceId) continue;
        for (let corner = 0; corner < 3; corner++) {
          const node = model.tris[t * 3 + corner];
          if (seen[node]) continue;
          seen[node] = 1;
          nodes.push(node);
        }
      }
      return Uint32Array.from(nodes);
    }
    case 'edge': {
      const chain = model.featureEdges.find((edge) => edge.id === target.edgeId);
      if (!chain) return NO_NODES;
      const seen = new Uint8Array(model.nodeCount);
      const nodes: number[] = [];
      for (const node of chain.nodes) {
        if (node >= model.nodeCount || seen[node]) continue;
        seen[node] = 1;
        nodes.push(node);
      }
      return Uint32Array.from(nodes);
    }
    case 'node':
      return target.nodeId < model.nodeCount ? Uint32Array.of(target.nodeId) : NO_NODES;
  }
}

/**
 * The triangles a target covers, for the area-based conditions.
 *
 * Part and face targets map to triangles directly. Edge and node targets have no area
 * of their own, so they take every incident triangle — "the film coefficient here"
 * rather than "on this patch".
 */
export function resolveTargetTriangles(model: ThermalModel, target: Target): Uint32Array {
  const partIndex = partIndexOf(model, target.partId);
  if (partIndex < 0) return NO_NODES;

  if (target.type === 'part' || target.type === 'face') {
    const tris: number[] = [];
    for (let t = 0; t < model.triCount; t++) {
      if (model.triPart[t] !== partIndex) continue;
      if (target.type === 'face' && model.triFace[t] !== target.faceId) continue;
      tris.push(t);
    }
    return Uint32Array.from(tris);
  }

  const nodes = resolveTargetNodes(model, target);
  if (nodes.length === 0) return NO_NODES;
  const selected = new Uint8Array(model.nodeCount);
  for (const node of nodes) selected[node] = 1;
  const tris: number[] = [];
  for (let t = 0; t < model.triCount; t++) {
    if (
      selected[model.tris[t * 3]] ||
      selected[model.tris[t * 3 + 1]] ||
      selected[model.tris[t * 3 + 2]]
    ) {
      tris.push(t);
    }
  }
  return Uint32Array.from(tris);
}

/**
 * The nodes a whole boundary condition covers: its members in order, each member's
 * own order kept, and every node once. A group holding a part and one of that part's
 * faces therefore names each node once, so an area-weighted load cannot double-inject.
 */
export function unionTargetNodes(model: ThermalModel, targets: readonly Target[]): Uint32Array {
  return unionOf(model.nodeCount, targets, (target) => resolveTargetNodes(model, target));
}

/** The same union over triangles, for the area-based conditions. */
export function unionTargetTriangles(model: ThermalModel, targets: readonly Target[]): Uint32Array {
  return unionOf(model.triCount, targets, (target) => resolveTargetTriangles(model, target));
}

function unionOf(
  indexCount: number,
  targets: readonly Target[],
  resolve: (target: Target) => Uint32Array,
): Uint32Array {
  // Both resolvers already deduplicate and bound their own output, so a lone member
  // needs no second pass.
  if (targets.length === 1) return resolve(targets[0]);
  const seen = new Uint8Array(indexCount);
  const out: number[] = [];
  for (const target of targets) {
    for (const index of resolve(target)) {
      if (seen[index]) continue;
      seen[index] = 1;
      out.push(index);
    }
  }
  return Uint32Array.from(out);
}

/** Per-triangle user-supplied film coefficient; NaN means "use the correlation". */
export function convectionOverrides(model: ThermalModel, scenario: Scenario): Float32Array {
  const overrides = new Float32Array(model.triCount).fill(Number.NaN);
  for (const bc of scenario.boundaryConditions) {
    if (bc.kind !== 'convection' || !bc.enabled || bc.h === 'auto') continue;
    for (const t of unionTargetTriangles(model, bc.targets)) overrides[t] = bc.h;
  }
  return overrides;
}

/** Carries a per-triangle surface coefficient onto nodes, split by what it exchanges with. */
export interface NodeSurfaceSplit {
  toAmbient: Float64Array;
  toCavity: Float64Array;
  /** Which cavity `toCavity` belongs to, per node. −1 where there is none. */
  nodeCavity: Int32Array;
}

/**
 * Splits an area-weighted carry-over in two, by the environment each triangle faces.
 *
 * A node on a cavity rim has incident triangles in both environments, and the single
 * blended coefficient the carry-over used to produce could only be aimed at one of them.
 * Each share is normalised by `nodeArea` exactly as `computeNodeEmissivity` does, so
 * `share·nodeArea` still reproduces Σ c_t·A_t/3 and the two shares sum to the old
 * blended value: no exchanging area is created or lost.
 *
 * Where a node's cavity-facing triangles span more than one cavity, the whole cavity
 * share goes to the one holding the largest area there rather than being divided. The
 * heat still lands in a sealed pocket, so only which pocket is approximate. That choice
 * is made on area alone, so it does not move when the coefficient does.
 */
export function splitNodeCoefficient(
  model: ThermalModel,
  perTriangle: ArrayLike<number>,
  cavityDof: Int32Array,
): NodeSurfaceSplit {
  const toAmbient = new Float64Array(model.nodeCount);
  const toCavity = new Float64Array(model.nodeCount);
  const nodeCavity = new Int32Array(model.nodeCount).fill(-1);
  // How much of each cavity a node sees, keyed node·stride + cavity, so the running
  // largest can be tracked without a map per node.
  const seenArea = new Map<number, number>();
  const stride = Math.max(1, cavityDof.length);
  const largestArea = new Float64Array(model.nodeCount);

  for (let t = 0; t < model.triCount; t++) {
    const cavity = liveCavityOf(model.triCavity[t], cavityDof);
    const share = (perTriangle[t] * model.triArea[t]) / 3;
    const area = model.triArea[t] / 3;
    for (let c = 0; c < 3; c++) {
      const node = model.tris[t * 3 + c];
      if (cavity < 0) {
        toAmbient[node] += share;
        continue;
      }
      toCavity[node] += share;
      const key = node * stride + cavity;
      const seen = (seenArea.get(key) ?? 0) + area;
      seenArea.set(key, seen);
      if (seen > largestArea[node]) {
        largestArea[node] = seen;
        nodeCavity[node] = cavity;
      }
    }
  }

  for (let node = 0; node < model.nodeCount; node++) {
    const area = model.nodeArea[node];
    toAmbient[node] = area > 0 ? toAmbient[node] / area : 0;
    toCavity[node] = area > 0 ? toCavity[node] / area : 0;
  }
  return { toAmbient, toCavity, nodeCavity };
}

/** The nodes belonging to a filled part, in index order. */
function* volumeNodes(model: ThermalModel, volume: VolumeDofs): Generator<number> {
  const part = model.parts[volume.mesh.partIndex];
  for (let node = part.nodeRange[0]; node < part.nodeRange[1]; node++) yield node;
}

/**
 * The DOF of the cavity a triangle exchanges with, or −1 when that is ambient: open
 * air, and a cavity with no DOF, are the same thing to everything downstream.
 */
function cavityDofOf(cavityId: number, cavityDof: Int32Array): number {
  return cavityId < cavityDof.length ? cavityDof[cavityId] : -1;
}

/** The same question answered as a cavity id, for the callers that group by pocket. */
function liveCavityOf(cavityId: number, cavityDof: Int32Array): number {
  return cavityDofOf(cavityId, cavityDof) >= 0 ? cavityId : -1;
}

/** Which cavities own a DOF, and how warm their air was on the previous Picard pass. */
export interface CavityState {
  /** `DofMap.cavityDof`: ≥ 0 for a live cavity, −1 otherwise. Indexed by cavity id. */
  dof: Int32Array;
  /** Cavity air temperature, kelvin, indexed by cavity id. */
  temperature: ArrayLike<number>;
}

/** A model with no live cavity: every surface exchanges with ambient, as it always did. */
const NO_CAVITIES: CavityState = { dof: new Int32Array(0), temperature: [] };

export interface SurfaceCoefficients {
  /**
   * W/(m²·K) per **triangle**. The correlation reads the surface normal, so a film
   * coefficient is a property of a face; assembly spreads each triangle's h·A_t/3 to
   * its three corners.
   */
  hConv: Float32Array;
  /** Effective emissivity per **node** aimed at ambient, area-weighted from its triangles. */
  emissivityToAmbient: Float64Array;
  /** …and the share aimed at `nodeCavity`. The two sum to the blended value. */
  emissivityToCavity: Float64Array;
  /** Which cavity the cavity-facing shares belong to, per node. −1 where there is none. */
  nodeCavity: Int32Array;
  /** W/(m²·K) per **node**, linearised at that node's own temperature against ambient. */
  hRadToAmbient: Float64Array;
  /** …and against its cavity's temperature, both taken at that node's own temperature. */
  hRadToCavity: Float64Array;
}

/**
 * Both radiation coefficients are linearised at the temperature the difference they
 * multiply is later taken at — the node's own on one side, and on the other the cavity
 * air's from the previous Picard pass, which is the only lag the coupling adds.
 */
export function surfaceCoefficients(
  model: ThermalModel,
  scenario: Scenario,
  temperature: Float32Array,
  cavities: CavityState = NO_CAVITIES,
): SurfaceCoefficients {
  const emissivity = splitNodeCoefficient(
    model,
    computeTriangleEmissivity(model, scenario),
    cavities.dof,
  );
  const hRadToAmbient = new Float64Array(model.nodeCount);
  const hRadToCavity = new Float64Array(model.nodeCount);
  for (let node = 0; node < model.nodeCount; node++) {
    hRadToAmbient[node] = radiationCoefficient(
      emissivity.toAmbient[node],
      temperature[node],
      scenario.ambient,
    );
    const cavity = emissivity.nodeCavity[node];
    if (cavity < 0) continue;
    hRadToCavity[node] = radiationCoefficient(
      emissivity.toCavity[node],
      temperature[node],
      cavities.temperature[cavity],
    );
  }

  return {
    hConv: computeConvectionCoefficients(
      model,
      scenario,
      temperature,
      convectionOverrides(model, scenario),
    ),
    emissivityToAmbient: emissivity.toAmbient,
    emissivityToCavity: emissivity.toCavity,
    nodeCavity: emissivity.nodeCavity,
    hRadToAmbient,
    hRadToCavity,
  };
}

/**
 * cot(θ)/2 at each vertex, indexed by the vertex the angle sits at: `out[0]` is the
 * weight of the edge opposite a — that is, edge (b, c).
 */
export function cotangentWeights(
  nodes: ArrayLike<number>,
  ia: number,
  ib: number,
  ic: number,
  out: Float64Array = new Float64Array(3),
): Float64Array {
  const ax = nodes[ia * 3];
  const ay = nodes[ia * 3 + 1];
  const az = nodes[ia * 3 + 2];
  const bx = nodes[ib * 3];
  const by = nodes[ib * 3 + 1];
  const bz = nodes[ib * 3 + 2];
  const cx = nodes[ic * 3];
  const cy = nodes[ic * 3 + 1];
  const cz = nodes[ic * 3 + 2];

  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;

  const crossX = aby * acz - abz * acy;
  const crossY = abz * acx - abx * acz;
  const crossZ = abx * acy - aby * acx;
  const twiceArea = Math.hypot(crossX, crossY, crossZ);
  if (!(twiceArea > 0)) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return out;
  }

  const bcx = cx - bx;
  const bcy = cy - by;
  const bcz = cz - bz;
  const scale = 1 / (2 * twiceArea);

  out[0] = (abx * acx + aby * acy + abz * acz) * scale;
  out[1] = (-abx * bcx - aby * bcy - abz * bcz) * scale;
  out[2] = (-acx * -bcx + -acy * -bcy + -acz * -bcz) * scale;
  return out;
}

export interface AssembledSystem {
  dofCount: number;
  /** The unconstrained system. Fixed-temperature rows are still intact here so the
   *  power injected at them can be recovered as a residual after the solve. */
  matrix: CsrMatrix;
  rhs: Float64Array;
  fixed: Uint8Array;
  fixedValue: Float64Array;
  /** Watts actually applied per DOF, for the heat balance. */
  loadPerDof: Float64Array;
  warnings: string[];
}

export function assembleSystem(
  model: ThermalModel,
  scenario: Scenario,
  dofs: DofMap,
  coefficients: SurfaceCoefficients,
): AssembledSystem {
  const { nodeDof, dofCount } = dofs;
  const warnings: string[] = [];
  // Conduction and cavity convection put up to twelve entries each per triangle, and
  // radiation up to five per node; the builder grows past this, it just need not.
  const builder = new SparseBuilder(dofCount, Math.max(16, model.triCount * 24 + dofCount * 5));
  const rhs = new Float64Array(dofCount);
  const loadPerDof = new Float64Array(dofCount);
  const fixed = new Uint8Array(dofCount);
  const fixedValue = new Float64Array(dofCount);

  // Reserve every diagonal slot so elimination always has one to write into.
  for (let dof = 0; dof < dofCount; dof++) builder.add(dof, dof, 0);

  // A part solved through its interior conducts nothing in plane: leaving the shell
  // term as well would put a second path along the skin, in parallel with the bulk and
  // far shorter — exactly the short circuit the volumetric mode exists to remove.
  const volumetric = volumetricParts(dofs);
  const conductance: number[] = [];
  const insulator: boolean[] = [];
  model.parts.forEach((part, index) => {
    const resolved = resolvePart(part, scenario.partOverrides[part.id]);
    conductance.push(
      volumetric.has(index) ? 0 : resolved.material.k * conductionThickness(part, resolved.thickness),
    );
    insulator.push(resolved.bodyType === 'insulator');
  });

  const weights = new Float64Array(3);
  const corner = new Int32Array(3);
  for (let t = 0; t < model.triCount; t++) {
    const part = model.triPart[t];
    if (insulator[part]) continue;

    corner[0] = model.tris[t * 3];
    corner[1] = model.tris[t * 3 + 1];
    corner[2] = model.tris[t * 3 + 2];

    const kt = conductance[part];
    if (kt > 0) {
      cotangentWeights(model.nodes, corner[0], corner[1], corner[2], weights);
      for (let opposite = 0; opposite < 3; opposite++) {
        // Obtuse triangles give a negative cotangent, which breaks diagonal dominance
        // and lets the solution overshoot into non-physical local extrema. Clamping to
        // zero is the standard robustness fix; remeshing is the alternative and is out
        // of scope.
        const g = kt * Math.max(0, weights[opposite]);
        if (g === 0) continue;
        const i = nodeDof[corner[(opposite + 1) % 3]];
        const j = nodeDof[corner[(opposite + 2) % 3]];
        // i === j inside a lump: conduction there is implicit in the shared DOF.
        if (i < 0 || j < 0 || i === j) continue;
        builder.add(i, i, g);
        builder.add(j, j, g);
        builder.add(i, j, -g);
        builder.add(j, i, -g);
      }
    }

    const hArea = (coefficients.hConv[t] * model.triArea[t]) / 3;
    if (hArea !== 0) {
      // A wall of a live cavity exchanges with the air trapped against it rather than
      // with the room. The coupling is symmetric and the cavity row takes no source
      // term, so at convergence that row states Σ h·A·(T_wall − T_cavity) = 0: energy
      // conservation for the pocket is imposed by the matrix, not asserted afterwards.
      const cav = cavityDofOf(model.triCavity[t], dofs.cavityDof);
      for (let c = 0; c < 3; c++) {
        const dof = nodeDof[corner[c]];
        if (dof < 0) continue;
        builder.add(dof, dof, hArea);
        if (cav < 0) {
          rhs[dof] += hArea * scenario.ambient;
          continue;
        }
        builder.add(cav, cav, hArea);
        builder.add(dof, cav, -hArea);
        builder.add(cav, dof, -hArea);
      }
    }
  }

  // Radiation is applied per node rather than spread from each triangle. h_rad·(T − T∞)
  // reproduces εσ(T⁴ − T∞⁴) exactly only when h_rad was linearised at the same T the
  // difference is taken at, and the balance takes it node by node. Emissivity is still
  // a per-triangle property; splitNodeCoefficient carries it onto nodes by area, so the
  // radiating area and its emissivities are unchanged — only the evaluation point moves.
  //
  // A rim node radiates in both directions, and its two shares are aimed at different
  // temperatures, which is why the split exists at all.
  for (let node = 0; node < model.nodeCount; node++) {
    const dof = nodeDof[node];
    if (dof < 0) continue;
    const area = model.nodeArea[node];

    const toAmbient = coefficients.hRadToAmbient[node] * area;
    if (toAmbient !== 0) {
      builder.add(dof, dof, toAmbient);
      rhs[dof] += toAmbient * scenario.ambient;
    }

    const cavity = coefficients.nodeCavity[node];
    const toCavity = coefficients.hRadToCavity[node] * area;
    if (cavity < 0 || toCavity === 0) continue;
    const cav = dofs.cavityDof[cavity];
    builder.add(dof, dof, toCavity);
    builder.add(cav, cav, toCavity);
    builder.add(dof, cav, -toCavity);
    builder.add(cav, dof, -toCavity);
  }

  for (const volume of dofs.volumes) {
    const part = model.parts[volume.mesh.partIndex];
    const k = resolvePart(part, scenario.partOverrides[part.id]).material.k;
    if (!(k > 0)) continue;
    const link = (a: number, b: number, g: number) => {
      builder.add(a, a, g);
      builder.add(b, b, g);
      builder.add(a, b, -g);
      builder.add(b, a, -g);
    };
    // Neighbours share a face of d² across a centre spacing of d, so k·d.
    const cellToCell = k * volume.mesh.cellSize;
    const { links } = volume.mesh;
    for (let i = 0; i < links.length; i += 2) {
      link(volume.dofBase + links[i], volume.dofBase + links[i + 1], cellToCell);
    }
    // ...and the surface reaches the first cell centre over half a cell, across the
    // node's own tributary area. In series that is d/2 + (n−1)·d + d/2 over k·A, which
    // is t/(k·A) exactly, at any cell count.
    for (const node of volumeNodes(model, volume)) {
      const cell = volume.mesh.nodeCell[node];
      if (cell < 0 || nodeDof[node] < 0) continue;
      const g = (2 * k * model.nodeArea[node]) / volume.mesh.cellSize;
      if (!(g > 0)) continue;
      link(nodeDof[node], volume.dofBase + cell, g);
    }
  }

  for (const contact of scenario.contacts) {
    if (!contact.enabled) continue;
    const pairCount = contact.nodePairs.length >> 1;
    let linked = 0;
    let unsolvedEnd = false;
    for (let pair = 0; pair < pairCount; pair++) {
      const g = contact.conductance * contact.pairArea[pair];
      if (!(g > 0)) continue;
      const i = nodeDof[contact.nodePairs[pair * 2]];
      const j = nodeDof[contact.nodePairs[pair * 2 + 1]];
      if (i < 0 || j < 0) {
        unsolvedEnd = true;
        continue;
      }
      if (i === j) continue;
      linked++;
      builder.add(i, i, g);
      builder.add(j, j, g);
      builder.add(i, j, -g);
      builder.add(j, i, -g);
    }
    // A joint onto an insulator part is not an error — the user asked for that part to
    // be left out — but it silently deletes a heat path, which is worth saying out loud.
    if (unsolvedEnd && linked === 0) {
      warnings.push(
        `Contact '${contact.id}' (${contact.partA} ↔ ${contact.partB}) links a part that is ` +
          `outside the system, so it carries no heat; make that part a sheet or a lump to use it`,
      );
    }
  }

  for (const bc of scenario.boundaryConditions) {
    if (!bc.enabled || bc.kind !== 'heatLoad') continue;
    // The union, so `watts` is the total over the group however its members overlap.
    const nodes = unionTargetNodes(model, bc.targets);
    let totalArea = 0;
    let count = 0;
    for (const node of nodes) {
      if (nodeDof[node] < 0) continue;
      totalArea += model.nodeArea[node];
      count++;
    }
    if (count === 0) {
      warnings.push(`Heat load '${bc.id}' matched no solvable nodes; its ${bc.watts} W is unused`);
      continue;
    }
    for (const node of nodes) {
      const dof = nodeDof[node];
      if (dof < 0) continue;
      const share = totalArea > 0 ? model.nodeArea[node] / totalArea : 1 / count;
      rhs[dof] += bc.watts * share;
      loadPerDof[dof] += bc.watts * share;
    }
  }

  for (const bc of scenario.boundaryConditions) {
    if (!bc.enabled || bc.kind !== 'fixedTemp') continue;
    const nodes = unionTargetNodes(model, bc.targets);
    let applied = 0;
    for (const node of nodes) {
      const dof = nodeDof[node];
      if (dof < 0) continue;
      if (fixed[dof] && Math.abs(fixedValue[dof] - bc.value) > 1e-9) {
        warnings.push(
          `Conflicting fixed temperatures on one DOF (${fixedValue[dof]} K vs ${bc.value} K from '${bc.id}'); the later one wins`,
        );
      }
      fixed[dof] = 1;
      fixedValue[dof] = bc.value;
      applied++;
    }
    if (applied === 0) warnings.push(`Fixed temperature '${bc.id}' matched no solvable nodes`);
  }

  const matrix = builder.compress();

  // A DOF with no conduction, no surface exchange and no contact has an empty row: the
  // matrix would be singular. Pin it to ambient and say so rather than solving garbage.
  const diagonal = matrix.diagonal();
  let isolated = 0;
  for (let dof = 0; dof < dofCount; dof++) {
    if (fixed[dof] || diagonal[dof] > 0) continue;
    fixed[dof] = 1;
    fixedValue[dof] = scenario.ambient;
    isolated++;
  }
  if (isolated > 0) {
    warnings.push(
      `${isolated} DOF(s) exchange no heat with anything (adiabatic and unconnected); pinned to ambient`,
    );
  }

  return { dofCount, matrix, rhs, fixed, fixedValue, loadPerDof, warnings };
}

/**
 * Symmetric row/column elimination of the fixed temperatures: zero the row and the
 * column, put 1 on the diagonal, and fold the known value into the free rows' RHS.
 * Keeps the system symmetric positive-definite, unlike a penalty term.
 *
 * `appliedNorm` is ‖rhs‖₂ *before* that folding. Every row is an equation in watts, so
 * it is the scale of the power actually applied to the model — and unlike ‖rhs‖ after
 * elimination it does not grow with contact conductance. Eliminating a node pinned at
 * 473 K behind a 1e4 W/K joint writes 5e6 into its neighbour's row, which says nothing
 * about how many watts the answer has to be right to. This is the scale the solver
 * judges the CG residual against; see `CgOptions.referenceNorm`.
 */
export function applyFixedTemperatures(system: AssembledSystem): {
  matrix: CsrMatrix;
  rhs: Float64Array;
  appliedNorm: number;
} {
  const matrix = system.matrix.clone();
  const rhs = Float64Array.from(system.rhs);
  const { rowPtr, colIndex, values } = matrix;

  let appliedNorm = 0;
  for (let row = 0; row < system.dofCount; row++) {
    if (!system.fixed[row]) appliedNorm += rhs[row] * rhs[row];
  }
  appliedNorm = Math.sqrt(appliedNorm);

  for (let row = 0; row < system.dofCount; row++) {
    if (system.fixed[row]) {
      for (let p = rowPtr[row]; p < rowPtr[row + 1]; p++) {
        values[p] = colIndex[p] === row ? 1 : 0;
      }
      rhs[row] = system.fixedValue[row];
      continue;
    }
    for (let p = rowPtr[row]; p < rowPtr[row + 1]; p++) {
      const col = colIndex[p];
      if (!system.fixed[col]) continue;
      rhs[row] -= values[p] * system.fixedValue[col];
      values[p] = 0;
    }
  }

  return { matrix, rhs, appliedNorm };
}
