/**
 * The solver entry point — spec §5 "Solve".
 *
 * A Picard outer loop around a Jacobi-preconditioned CG solve: convection and
 * radiation coefficients are frozen from the current field, the linear system is
 * assembled and solved, and the new field feeds the next set of coefficients.
 *
 * Everything here is synchronous and free of three.js and the DOM so the whole solve
 * runs in Node under vitest; `worker.ts` is the only browser-specific wrapper.
 */

import { computeHeatBalance, type ConductionEdges } from '../analysis/balance';
import type {
  HeatBalance,
  Scenario,
  SolveResult,
  ThermalModel,
  ThermalSolver,
} from '../core/types';
import {
  applyFixedTemperatures,
  assembleSystem,
  buildDofMap,
  conductionThickness,
  cotangentWeights,
  surfaceCoefficients,
  type DofMap,
  type SurfaceCoefficients,
} from './assemble';
import { resolvePart } from './materials';
import { radiationCoefficient } from './radiation';
import { conjugateGradient } from './sparse';

/**
 * A balance is reported as broken when |residual| exceeds this share of the power
 * flowing through the model. The residual is never scaled or clamped away: at this
 * size it means the discretisation and the accounting disagree about real watts, and
 * every number downstream of it is suspect.
 */
export const ENERGY_RESIDUAL_FRACTION = 0.01;

/**
 * Below this the residual is rounding in the Float32Array field the balance is read
 * from, not physics. Watts — and a microwatt is nothing in a natural-convection model.
 */
const RESIDUAL_NOISE_FLOOR = 1e-6;

/**
 * The power scale |residual| is judged against.
 *
 * Per-part and per-contact magnitudes rather than the net injection: a part bolted
 * between a hot source and a cold sink passes real watts while `injectedAtFixed` nets
 * to zero, and a threshold measured against zero would cry wolf on every such model.
 */
export function heatThroughput(balance: HeatBalance): number {
  let injected = 0;
  for (const part of balance.perPart) injected += Math.abs(part.injected);
  let acrossContacts = 0;
  for (const contact of balance.perContact) acrossContacts += Math.abs(contact.watts);
  return Math.max(
    injected,
    acrossContacts,
    Math.abs(balance.lostByConvection) + Math.abs(balance.lostByRadiation),
  );
}

/**
 * Steady-state shell solve.
 *
 * Nodes belonging to `insulator` parts are outside the linear system and are reported
 * at ambient — not NaN, so that the colour scale, the balance and the pick readout all
 * stay finite. `minTemp`/`maxTemp` cover only the nodes that were actually solved.
 */
export function solveShell(
  model: ThermalModel,
  scenario: Scenario,
  previous?: Float32Array,
): SolveResult {
  const startedAt = performance.now();
  const warnings: string[] = [];
  // assembleSystem re-reports the same complaints on every outer iteration.
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  const dofs = buildDofMap(model, scenario);
  if (dofs.dofCount === 0) {
    warn('No solvable nodes: every part is an insulator, so nothing was solved');
  }

  const temperature = initialTemperature(model, scenario, previous);
  // The field the current coefficients were evaluated from. Reporting the balance
  // against these rather than against freshly recomputed ones keeps the accounting
  // consistent with the matrix that produced the answer.
  const coefficientTemperature = new Float32Array(model.nodeCount);
  let coefficients: SurfaceCoefficients;
  let loadPerDof: Float64Array;
  let fixedDof: Uint8Array;

  let dofSolution: Float64Array = new Float64Array(dofs.dofCount);
  for (let node = 0; node < model.nodeCount; node++) {
    const dof = dofs.nodeDof[node];
    if (dof >= 0) dofSolution[dof] = temperature[node];
  }

  let outerIterations = 0;
  let converged: boolean;
  const maxOuter = Math.max(1, Math.floor(scenario.solver.maxOuterIterations) || 1);

  // Always at least one pass: a caller who asks for zero iterations still wants a
  // field and a balance, with the warning that says how little was done to it.
  do {
    coefficientTemperature.set(temperature);
    coefficients = surfaceCoefficients(model, scenario, coefficientTemperature);
    const system = assembleSystem(model, scenario, dofs, coefficients);
    for (const message of system.warnings) warn(message);
    loadPerDof = system.loadPerDof;
    fixedDof = system.fixed;

    const { matrix, rhs } = applyFixedTemperatures(system);
    const cg = conjugateGradient(matrix, rhs, {
      tolerance: scenario.solver.cgTolerance,
      maxIterations: scenario.solver.maxCgIterations,
      initialGuess: dofSolution,
    });
    outerIterations++;
    if (!cg.converged && dofs.dofCount > 0) {
      warn(
        `Conjugate gradient stopped at a relative residual of ${cg.relativeResidual.toExponential(2)} ` +
          `after ${cg.iterations} iterations (target ${scenario.solver.cgTolerance.toExponential(2)}); ` +
          `the field may not satisfy the assembled system`,
      );
    }
    dofSolution = cg.x;

    const change = writeNodeTemperatures(model, dofs, cg.x, scenario.ambient, temperature);
    converged = change < scenario.solver.tolerance;
  } while (!converged && outerIterations < maxOuter);

  if (!converged) {
    warn(
      `Outer loop hit its ${maxOuter}-iteration cap without reaching ${scenario.solver.tolerance} K; ` +
        `convection and radiation coefficients are still moving`,
    );
  }

  const surface = nodeSurfaceProperties(model, coefficients, coefficientTemperature, scenario);
  const balance = computeHeatBalance({
    model,
    scenario,
    temperature,
    hConvection: surface.hConvection,
    emissivity: surface.emissivity,
    conduction: conductionEdges(model, scenario, dofs),
    fixedNodes: fixedNodeList(model, dofs, fixedDof),
    nodeLoad: nodeLoads(model, dofs, loadPerDof),
  });

  const limit = Math.max(ENERGY_RESIDUAL_FRACTION * heatThroughput(balance), RESIDUAL_NOISE_FLOOR);
  if (!(Math.abs(balance.residual) <= limit)) {
    warn(
      `Energy balance does not close: ${balance.residual.toPrecision(4)} W unaccounted for against ` +
        `${heatThroughput(balance).toPrecision(4)} W of throughput. The reported field does not ` +
        `conserve energy and should not be trusted`,
    );
  }

  const extent = solvedExtent(model, dofs, temperature, scenario.ambient);

  return {
    temperature,
    minTemp: extent.min,
    maxTemp: extent.max,
    balance,
    outerIterations,
    converged,
    warnings,
    elapsedMs: performance.now() - startedAt,
  };
}

export const shellSolver: ThermalSolver = {
  id: 'shell',
  solve(model: ThermalModel, scenario: Scenario, previous?: Float32Array): Promise<SolveResult> {
    return Promise.resolve(solveShell(model, scenario, previous));
  },
};

function initialTemperature(
  model: ThermalModel,
  scenario: Scenario,
  previous?: Float32Array,
): Float32Array {
  const temperature = new Float32Array(model.nodeCount).fill(scenario.ambient);
  if (!scenario.solver.warmStart || !previous || previous.length !== model.nodeCount) {
    return temperature;
  }
  for (let node = 0; node < model.nodeCount; node++) {
    if (Number.isFinite(previous[node])) temperature[node] = previous[node];
  }
  return temperature;
}

/**
 * Expands the DOF solution onto nodes and returns max |ΔT| over the solved nodes —
 * the Picard convergence measure. Every node of a lump part takes its shared DOF's
 * value, which is what makes the part isothermal.
 */
function writeNodeTemperatures(
  model: ThermalModel,
  dofs: DofMap,
  solution: Float64Array,
  ambient: number,
  temperature: Float32Array,
): number {
  let change = 0;
  for (let node = 0; node < model.nodeCount; node++) {
    const dof = dofs.nodeDof[node];
    if (dof < 0) {
      temperature[node] = ambient;
      continue;
    }
    const value = solution[dof];
    change = Math.max(change, Math.abs(value - temperature[node]));
    temperature[node] = value;
  }
  return change;
}

function solvedExtent(
  model: ThermalModel,
  dofs: DofMap,
  temperature: Float32Array,
  ambient: number,
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let node = 0; node < model.nodeCount; node++) {
    if (dofs.nodeDof[node] < 0) continue;
    min = Math.min(min, temperature[node]);
    max = Math.max(max, temperature[node]);
  }
  return Number.isFinite(min) ? { min, max } : { min: ambient, max: ambient };
}

interface NodeSurfaceProperties {
  hConvection: Float64Array;
  emissivity: Float64Array;
}

/**
 * Per-node film coefficient and effective emissivity, area-weighted from the
 * per-triangle values.
 *
 * The assembly spreads h·A_t/3 to each corner while the balance integrates h·nodeArea,
 * so the area-weighted mean is the one choice that makes the two agree exactly.
 * Emissivity is recovered by dividing the linearised h_rad by its ε = 1 value rather
 * than re-deriving finish/cavity/insulator precedence, which belongs to radiation.ts.
 */
function nodeSurfaceProperties(
  model: ThermalModel,
  coefficients: SurfaceCoefficients,
  coefficientTemperature: Float32Array,
  scenario: Scenario,
): NodeSurfaceProperties {
  const hConvection = new Float64Array(model.nodeCount);
  const emissivity = new Float64Array(model.nodeCount);

  for (let t = 0; t < model.triCount; t++) {
    const a = model.tris[t * 3];
    const b = model.tris[t * 3 + 1];
    const c = model.tris[t * 3 + 2];
    const share = model.triArea[t] / 3;
    const surfaceT =
      (coefficientTemperature[a] + coefficientTemperature[b] + coefficientTemperature[c]) / 3;
    const unitRadiation = radiationCoefficient(1, surfaceT, scenario.ambient);
    const effectiveEmissivity = unitRadiation > 0 ? coefficients.hRad[t] / unitRadiation : 0;
    for (let corner = 0; corner < 3; corner++) {
      const node = model.tris[t * 3 + corner];
      hConvection[node] += coefficients.hConv[t] * share;
      emissivity[node] += effectiveEmissivity * share;
    }
  }

  for (let node = 0; node < model.nodeCount; node++) {
    const area = model.nodeArea[node];
    if (area > 0) {
      hConvection[node] /= area;
      emissivity[node] /= area;
    } else {
      hConvection[node] = 0;
      emissivity[node] = 0;
    }
  }
  return { hConvection, emissivity };
}

/**
 * The shell conductances as an undirected edge list for the balance.
 *
 * Mirrors `assembleSystem`'s conduction stencil entry for entry — same cotangent
 * weights, same negative clamp, same skips. If the two ever drift apart the energy
 * residual stops closing, which is exactly the signal we want.
 */
function conductionEdges(model: ThermalModel, scenario: Scenario, dofs: DofMap): ConductionEdges {
  const nodes = new Uint32Array(model.triCount * 6);
  const conductance = new Float64Array(model.triCount * 3);
  let edgeCount = 0;

  const sheetConductance = model.parts.map((part) => {
    const resolved = resolvePart(part, scenario.partOverrides[part.id]);
    return resolved.bodyType === 'insulator'
      ? 0
      : resolved.material.k * conductionThickness(part, resolved.thickness);
  });

  const weights = new Float64Array(3);
  const corner = new Int32Array(3);
  for (let t = 0; t < model.triCount; t++) {
    const kt = sheetConductance[model.triPart[t]] ?? 0;
    if (!(kt > 0)) continue;
    corner[0] = model.tris[t * 3];
    corner[1] = model.tris[t * 3 + 1];
    corner[2] = model.tris[t * 3 + 2];
    cotangentWeights(model.nodes, corner[0], corner[1], corner[2], weights);

    for (let opposite = 0; opposite < 3; opposite++) {
      const g = kt * Math.max(0, weights[opposite]);
      if (g === 0) continue;
      const from = corner[(opposite + 1) % 3];
      const to = corner[(opposite + 2) % 3];
      const i = dofs.nodeDof[from];
      const j = dofs.nodeDof[to];
      if (i < 0 || j < 0 || i === j) continue;
      nodes[edgeCount * 2] = from;
      nodes[edgeCount * 2 + 1] = to;
      conductance[edgeCount] = g;
      edgeCount++;
    }
  }

  return {
    nodes: nodes.slice(0, edgeCount * 2),
    conductance: conductance.slice(0, edgeCount),
  };
}

/** Every node whose DOF is pinned, including a lump's nodes when its shared DOF is. */
function fixedNodeList(model: ThermalModel, dofs: DofMap, fixedDof: Uint8Array): Uint32Array {
  const fixed: number[] = [];
  for (let node = 0; node < model.nodeCount; node++) {
    const dof = dofs.nodeDof[node];
    if (dof >= 0 && fixedDof[dof]) fixed.push(node);
  }
  return Uint32Array.from(fixed);
}

/**
 * Splits each DOF's applied load back over its nodes by area. Identity for sheet
 * nodes; for a lump only the total per DOF is meaningful, and the total is what the
 * balance integrates.
 */
function nodeLoads(model: ThermalModel, dofs: DofMap, loadPerDof: Float64Array): Float64Array {
  const dofArea = new Float64Array(dofs.dofCount);
  const dofNodeCount = new Int32Array(dofs.dofCount);
  for (let node = 0; node < model.nodeCount; node++) {
    const dof = dofs.nodeDof[node];
    if (dof < 0) continue;
    dofArea[dof] += model.nodeArea[node];
    dofNodeCount[dof]++;
  }

  const load = new Float64Array(model.nodeCount);
  for (let node = 0; node < model.nodeCount; node++) {
    const dof = dofs.nodeDof[node];
    if (dof < 0 || loadPerDof[dof] === 0) continue;
    const share =
      dofArea[dof] > 0 ? model.nodeArea[node] / dofArea[dof] : 1 / Math.max(1, dofNodeCount[dof]);
    load[node] = loadPerDof[dof] * share;
  }
  return load;
}
