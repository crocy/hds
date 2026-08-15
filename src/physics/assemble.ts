/**
 * ThermalModel + Scenario → the linear system.
 *
 * Everything model-aware lives here: the DOF map (the one place `bodyType` is
 * special-cased), target resolution, cotangent conduction weights, surface exchange,
 * contacts, loads, and fixed-temperature elimination. Convection and radiation are
 * pure correlations in their own modules; this file decides where they apply.
 */

import type { Part, Scenario, Target, ThermalModel } from '../core/types';
import { computeConvectionCoefficients } from './convection';
import { resolvePart } from './materials';
import { computeRadiationCoefficients } from './radiation';
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
 * A `sheet` node gets its own DOF; every node of a `lump` shares one, which makes the
 * part internally isothermal while it still exchanges heat over its full area; an
 * `insulator` gets −1 and drops out of the system entirely.
 */
export function buildDofMap(model: ThermalModel, scenario: Scenario): DofMap {
  const nodeDof = new Int32Array(model.nodeCount).fill(-1);
  const bodyTypes = model.parts.map(
    (part) => resolvePart(part, scenario.partOverrides[part.id]).bodyType,
  );
  const lumpDof = new Int32Array(model.parts.length).fill(-1);
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
    } else {
      nodeDof[node] = dofCount++;
      dofPart.push(part);
    }
  }

  return { nodeDof, dofPart: Int32Array.from(dofPart), dofCount };
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
  /** W/(m²·K) per triangle. */
  hConv: Float32Array;
  hRad: Float32Array;
}

export function surfaceCoefficients(
  model: ThermalModel,
  scenario: Scenario,
  temperature: Float32Array,
): SurfaceCoefficients {
  return {
    hConv: computeConvectionCoefficients(
      model,
      scenario,
      temperature,
      convectionOverrides(model, scenario),
    ),
    hRad: computeRadiationCoefficients(model, scenario, temperature),
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

    const hArea = ((coefficients.hConv[t] + coefficients.hRad[t]) * model.triArea[t]) / 3;
    if (hArea !== 0) {
      for (let c = 0; c < 3; c++) {
        const dof = nodeDof[corner[c]];
        if (dof < 0) continue;
        builder.add(dof, dof, hArea);
        rhs[dof] += hArea * scenario.ambient;
      }
    }
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
