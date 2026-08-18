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
  splitNodeCoefficient,
  surfaceCoefficients,
  type DofMap,
  type SurfaceCoefficients,
} from './assemble';
import { resolvePart } from './materials';
import { conjugateGradient } from './sparse';

/**
 * A balance is reported as broken when |residual| exceeds this share of the power
 * flowing through the model. The residual is never scaled or clamped away: at this
 * size it means the discretisation and the accounting disagree about real watts, and
 * every number downstream of it is suspect.
 *
 * Two orders of magnitude above what a converged solve reaches — measured 2e-6 on the
 * radiating fin benchmarks and 7e-6 on the TBTE housing, both of them h_rad lagging one
 * Picard iteration behind the field and nothing else. A looser bar than this cannot
 * tell a solver that stopped early from one that finished.
 */
export const ENERGY_RESIDUAL_FRACTION = 1e-3;

/**
 * Absolute floor on the alarm, in watts. A model sitting at ambient has no throughput
 * for a fraction to be taken of, and must not be called broken over the last bits of a
 * sum of a few thousand terms.
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
  if (dofs.nodeDofCount === 0) {
    warn('No solvable nodes: every part is an insulator, so nothing was solved');
  }

  const temperature = initialTemperature(model, scenario, previous);
  // The same field the caller gets, at the precision it was solved to. The balance is
  // taken from this rather than from `temperature`: a Float32 temperature near 500 K is
  // quantised to ~3e-5 K, and across a PERFECT_CONTACT joint carrying 1e4 W/K that
  // rounding alone is worth tens of milliwatts of phantom flux. The residual has to
  // measure the solve, not the storage the answer is handed back in.
  const solvedTemperature = new Float64Array(model.nodeCount);
  // The field the current coefficients were evaluated from. Reporting the balance
  // against these rather than against freshly recomputed ones keeps the accounting
  // consistent with the matrix that produced the answer.
  const coefficientTemperature = new Float32Array(model.nodeCount);
  // Indexed by cavity id, and starting at ambient: the first pass linearises
  // wall-to-cavity radiation there, and every later one against what the pocket solved to.
  const cavityTemperature = new Float64Array(dofs.cavityDof.length).fill(scenario.ambient);
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
    coefficients = surfaceCoefficients(model, scenario, coefficientTemperature, {
      dof: dofs.cavityDof,
      temperature: cavityTemperature,
    });
    const system = assembleSystem(model, scenario, dofs, coefficients);
    for (const message of system.warnings) warn(message);
    loadPerDof = system.loadPerDof;
    fixedDof = system.fixed;

    const { matrix, rhs, appliedNorm } = applyFixedTemperatures(system);
    // Judged against ‖rhs‖ instead, the tolerance would be measured on a scale a stiff
    // contact sets rather than one the physics does, and the watts CG leaves behind —
    // which are exactly what the heat balance reports as its residual — would grow with
    // the joint's conductance instead of staying put.
    const cg = conjugateGradient(matrix, rhs, {
      tolerance: scenario.solver.cgTolerance,
      referenceNorm: appliedNorm,
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

    const change = Math.max(
      writeNodeTemperatures(model, dofs, cg.x, scenario.ambient, temperature, solvedTemperature),
      readCavityTemperatures(dofs, cg.x, cavityTemperature),
    );
    converged = change < scenario.solver.tolerance;
  } while (!converged && outerIterations < maxOuter);

  if (!converged) {
    warn(
      `Outer loop hit its ${maxOuter}-iteration cap without reaching ${scenario.solver.tolerance} K; ` +
        `convection and radiation coefficients are still moving`,
    );
  }

  // The balance works per node, the assembly convects per triangle: the same
  // area-weighted carry-over the emissivity goes through is what makes the two agree
  // exactly, and it splits the film coefficient by environment for the same reason.
  const convection = splitNodeCoefficient(model, coefficients.hConv, dofs.cavityDof);
  const balance = computeHeatBalance({
    model,
    scenario,
    temperature: solvedTemperature,
    hConvection: convection.toAmbient,
    emissivity: coefficients.emissivityToAmbient,
    conduction: conductionEdges(model, scenario, dofs),
    fixedNodes: fixedNodeList(model, dofs, fixedDof),
    nodeLoad: nodeLoads(model, dofs, loadPerDof),
    nodeDof: dofs.nodeDof,
    cavity: {
      nodeCavity: coefficients.nodeCavity,
      hConvection: convection.toCavity,
      emissivity: coefficients.emissivityToCavity,
      temperature: cavityTemperature,
    },
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
 *
 * Written twice: `temperature` is what the caller renders and picks against, `solved`
 * is the same field undiminished, for the balance to account watts from.
 */
function writeNodeTemperatures(
  model: ThermalModel,
  dofs: DofMap,
  solution: Float64Array,
  ambient: number,
  temperature: Float32Array,
  solved: Float64Array,
): number {
  let change = 0;
  for (let node = 0; node < model.nodeCount; node++) {
    const dof = dofs.nodeDof[node];
    if (dof < 0) {
      temperature[node] = ambient;
      solved[node] = ambient;
      continue;
    }
    const value = solution[dof];
    change = Math.max(change, Math.abs(value - temperature[node]));
    temperature[node] = value;
    solved[node] = value;
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

/**
 * Reads the cavity tail of the solution — the DOFs past `nodeDofCount` — and returns
 * max |ΔT| over it.
 *
 * That change belongs in the Picard measure alongside the walls': the next pass
 * linearises wall-to-cavity radiation against these temperatures, so a pocket still
 * moving is a coefficient still moving.
 */
function readCavityTemperatures(
  dofs: DofMap,
  solution: Float64Array,
  cavityTemperature: Float64Array,
): number {
  let change = 0;
  for (let cavity = 0; cavity < dofs.cavityDof.length; cavity++) {
    const dof = dofs.cavityDof[cavity];
    if (dof < 0) continue;
    change = Math.max(change, Math.abs(solution[dof] - cavityTemperature[cavity]));
    cavityTemperature[cavity] = solution[dof];
  }
  return change;
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
  const dofArea = new Float64Array(dofs.nodeDofCount);
  const dofNodeCount = new Int32Array(dofs.nodeDofCount);
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
