/**
 * ThermalModel + Scenario → the linear system.
 *
 * Everything model-aware lives here: the DOF map (the one place `bodyType` is
 * special-cased), target resolution, cotangent conduction weights, surface exchange,
 * contacts, loads, and fixed-temperature elimination. Convection and radiation are
 * pure correlations in their own modules; this file decides where they apply.
 */

import type { Part, Scenario, Target, ThermalModel } from '../core/types';
import { buildBvh, createHitBuffer, raycastInto, type Bvh, type HitBuffer } from '../geometry/bvh';
import { computeConvectionCoefficients } from './convection';
import { resolvePart } from './materials';
import { computeNodeEmissivity, computeNodeRadiationCoefficients } from './radiation';
import { CsrMatrix, SparseBuilder } from './sparse';

const NO_NODES = new Uint32Array(0);

export interface DofMap {
  /** node → degree of freedom, −1 for nodes excluded from the system. */
  nodeDof: Int32Array;
  /** dof → owning part index. DOFs never span parts. */
  dofPart: Int32Array;
  dofCount: number;
}

/**
 * A `sheet` node gets its own DOF, except that the two nodes facing each other across a
 * sheet solid's thickness share one (see `pairThroughThickness`); every node of a
 * `lump` shares one, which makes the part internally isothermal while it still
 * exchanges heat over its full area; an `insulator` gets −1 and drops out of the system
 * entirely.
 */
export function buildDofMap(model: ThermalModel, scenario: Scenario): DofMap {
  const nodeDof = new Int32Array(model.nodeCount).fill(-1);
  const bodyTypes = model.parts.map(
    (part) => resolvePart(part, scenario.partOverrides[part.id]).bodyType,
  );
  const lumpDof = new Int32Array(model.parts.length).fill(-1);
  const opposite = pairThroughThickness(model, scenario);
  const dofPart: number[] = [];
  let dofCount = 0;

  for (let node = 0; node < model.nodeCount; node++) {
    const part = model.nodePart[node];
    const bodyType = bodyTypes[part] ?? 'sheet';
    if (bodyType === 'insulator') continue;
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

  return { nodeDof, dofPart: Int32Array.from(dofPart), dofCount };
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

/** Per-triangle user-supplied film coefficient; NaN means "use the correlation". */
export function convectionOverrides(model: ThermalModel, scenario: Scenario): Float32Array {
  const overrides = new Float32Array(model.triCount).fill(Number.NaN);
  for (const bc of scenario.boundaryConditions) {
    if (bc.kind !== 'convection' || !bc.enabled || bc.h === 'auto') continue;
    for (const t of resolveTargetTriangles(model, bc.target)) overrides[t] = bc.h;
  }
  return overrides;
}

export interface SurfaceCoefficients {
  /**
   * W/(m²·K) per **triangle**. The correlation reads the surface normal, so a film
   * coefficient is a property of a face; assembly spreads each triangle's h·A_t/3 to
   * its three corners.
   */
  hConv: Float32Array;
  /** Effective emissivity per **node**, area-weighted from its incident triangles. */
  emissivity: Float64Array;
  /** W/(m²·K) per **node**, linearised at that node's own temperature. */
  hRad: Float64Array;
}

export function surfaceCoefficients(
  model: ThermalModel,
  scenario: Scenario,
  temperature: Float32Array,
): SurfaceCoefficients {
  const emissivity = computeNodeEmissivity(model, scenario);
  return {
    hConv: computeConvectionCoefficients(
      model,
      scenario,
      temperature,
      convectionOverrides(model, scenario),
    ),
    emissivity,
    hRad: computeNodeRadiationCoefficients(model, emissivity, temperature, scenario.ambient),
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
  const builder = new SparseBuilder(dofCount, Math.max(16, model.triCount * 12 + dofCount));
  const rhs = new Float64Array(dofCount);
  const loadPerDof = new Float64Array(dofCount);
  const fixed = new Uint8Array(dofCount);
  const fixedValue = new Float64Array(dofCount);

  // Reserve every diagonal slot so elimination always has one to write into.
  for (let dof = 0; dof < dofCount; dof++) builder.add(dof, dof, 0);

  const conductance: number[] = [];
  const insulator: boolean[] = [];
  for (const part of model.parts) {
    const resolved = resolvePart(part, scenario.partOverrides[part.id]);
    conductance.push(resolved.material.k * conductionThickness(part, resolved.thickness));
    insulator.push(resolved.bodyType === 'insulator');
  }

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
      for (let c = 0; c < 3; c++) {
        const dof = nodeDof[corner[c]];
        if (dof < 0) continue;
        builder.add(dof, dof, hArea);
        rhs[dof] += hArea * scenario.ambient;
      }
    }
  }

  // Radiation is applied per node rather than spread from each triangle. h_rad·(T − T∞)
  // reproduces εσ(T⁴ − T∞⁴) exactly only when h_rad was linearised at the same T the
  // difference is taken at, and the balance takes it node by node. Emissivity is still
  // a per-triangle property; computeNodeEmissivity carries it onto nodes by area, so the
  // radiating area and its emissivities are unchanged — only the evaluation point moves.
  for (let node = 0; node < model.nodeCount; node++) {
    const dof = nodeDof[node];
    if (dof < 0) continue;
    const hArea = coefficients.hRad[node] * model.nodeArea[node];
    if (hArea === 0) continue;
    builder.add(dof, dof, hArea);
    rhs[dof] += hArea * scenario.ambient;
  }

  for (const contact of scenario.contacts) {
    if (!contact.enabled) continue;
    const pairCount = contact.nodePairs.length >> 1;
    for (let pair = 0; pair < pairCount; pair++) {
      const g = contact.conductance * contact.pairArea[pair];
      if (!(g > 0)) continue;
      const i = nodeDof[contact.nodePairs[pair * 2]];
      const j = nodeDof[contact.nodePairs[pair * 2 + 1]];
      if (i < 0 || j < 0 || i === j) continue;
      builder.add(i, i, g);
      builder.add(j, j, g);
      builder.add(i, j, -g);
      builder.add(j, i, -g);
    }
  }

  for (const bc of scenario.boundaryConditions) {
    if (!bc.enabled || bc.kind !== 'heatLoad') continue;
    const nodes = resolveTargetNodes(model, bc.target);
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
    const nodes = resolveTargetNodes(model, bc.target);
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
 */
export function applyFixedTemperatures(system: AssembledSystem): {
  matrix: CsrMatrix;
  rhs: Float64Array;
} {
  const matrix = system.matrix.clone();
  const rhs = Float64Array.from(system.rhs);
  const { rowPtr, colIndex, values } = matrix;

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

  return { matrix, rhs };
}
