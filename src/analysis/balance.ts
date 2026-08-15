/**
 * Heat balance — spec §7.3.
 *
 * The standalone, recomputable version: a pure function of a temperature field
 * and the coefficients that produced it, so the UI can re-report a balance (or a
 * what-if) without re-entering the solver.
 *
 * Radiation is evaluated from the full Stefan–Boltzmann law rather than the
 * solver's linearised h_rad, and the two agree to the last bit rather than
 * approximately, because the solver linearises **per node**:
 *   h_rad(T)·(T − T∞) = εσ(T² + T∞²)(T + T∞)(T − T∞) = εσ(T⁴ − T∞⁴)
 * is an algebraic identity whenever the coefficient was built from the same T the
 * difference is taken at. So this is a genuine independent check of the assembly —
 * a non-zero residual means a real disagreement about watts, never a linearisation
 * artefact of the mesh.
 */

import type { Contact, HeatBalance, Scenario, ThermalModel } from '../core/types';

const STEFAN_BOLTZMANN = 5.670374419e-8;

/** Assembled shell conductances, W/K. Contact links are NOT included here. */
export interface ConductionEdges {
  /** Undirected edge endpoints: nodes[2e] ↔ nodes[2e + 1]. */
  nodes: Uint32Array;
  /** W/K for each edge. length = nodes.length / 2 */
  conductance: Float64Array;
}

/**
 * What each node exchanges with the air sealed against it, rather than with the room.
 *
 * The `toCavity` half of the same split whose `toAmbient` half arrives as `hConvection`
 * and `emissivity`, plus the temperature that air settled at. Absent when nothing in the
 * model faces a cavity that has a temperature of its own.
 */
export interface CavityExchange {
  /** Which cavity each node exchanges with, by id. −1 where there is none. length = nodeCount */
  nodeCavity: ArrayLike<number>;
  /** Film coefficient toward that cavity, W/(m²·K). length = nodeCount */
  hConvection: ArrayLike<number>;
  /** Emissivity toward that cavity, 0..1. length = nodeCount */
  emissivity: ArrayLike<number>;
  /** Cavity air temperature, kelvin, indexed by cavity id. */
  temperature: ArrayLike<number>;
}

export interface HeatBalanceInput {
  model: ThermalModel;
  scenario: Scenario;
  /** Node temperatures, kelvin. length = nodeCount */
  temperature: ArrayLike<number>;
  /** Convective film coefficient per node, W/(m²·K). length = nodeCount */
  hConvection: ArrayLike<number>;
  /**
   * Effective emissivity per node, 0..1. Cavity de-rating is the caller's job —
   * this module does not know about enclosure approximations.
   */
  emissivity: ArrayLike<number>;
  conduction: ConductionEdges;
  /** Nodes pinned by fixedTemp boundary conditions; the caller resolves Targets. */
  fixedNodes: ArrayLike<number>;
  /** Watts injected at each node by heatLoad boundary conditions. length = nodeCount */
  nodeLoad: ArrayLike<number>;
  cavity?: CavityExchange;
}

function convectiveLoss(input: HeatBalanceInput, node: number): number {
  return (
    input.hConvection[node] *
    input.model.nodeArea[node] *
    (input.temperature[node] - input.scenario.ambient)
  );
}

function radiativeLoss(input: HeatBalanceInput, node: number): number {
  const ambient = input.scenario.ambient;
  const t = input.temperature[node];
  return (
    input.emissivity[node] *
    STEFAN_BOLTZMANN *
    input.model.nodeArea[node] *
    (t * t * t * t - ambient * ambient * ambient * ambient)
  );
}

/**
 * Watts a node sheds into the cavity it walls — convection and radiation both taken
 * against the cavity air rather than against ambient. Zero for a node facing the room.
 */
function cavityLoss(input: HeatBalanceInput, node: number): number {
  const { cavity } = input;
  if (!cavity) return 0;
  const id = cavity.nodeCavity[node];
  if (id < 0) return 0;

  const air = cavity.temperature[id];
  const t = input.temperature[node];
  const area = input.model.nodeArea[node];
  return (
    cavity.hConvection[node] * area * (t - air) +
    cavity.emissivity[node] * STEFAN_BOLTZMANN * area * (t * t * t * t - air * air * air * air)
  );
}

/**
 * Net watts into each cavity, summed over the walls that bound it.
 *
 * A sealed pocket has nowhere to put them, so every entry must come out ~0. Nothing here
 * reads the assembled matrix — this is the wall flows added up a second time, from the
 * temperatures the solve produced, which is what makes it a check rather than a
 * restatement of the row that imposed it.
 */
function cavityNetFlow(input: HeatBalanceInput): HeatBalance['perCavity'] {
  const { cavity } = input;
  if (!cavity) return [];

  const netFlow = new Map<number, number>();
  for (let node = 0; node < input.model.nodeCount; node++) {
    const id = cavity.nodeCavity[node];
    if (id < 0) continue;
    netFlow.set(id, (netFlow.get(id) ?? 0) + cavityLoss(input, node));
  }

  return [...netFlow]
    .sort(([a], [b]) => a - b)
    .map(([cavityId, watts]) => ({
      cavityId,
      temperature: cavity.temperature[cavityId],
      netFlow: watts,
    }));
}

function contactConductance(contact: Contact, pair: number): number {
  return contact.conductance * contact.pairArea[pair];
}

/**
 * Watts crossing a contact, positive when heat flows from partA to partB.
 * `outflow`, when given, accumulates each node's net conductive outflow through
 * contacts — the term a fixed node's injected power needs.
 */
function contactWatts(
  contact: Contact,
  temperature: ArrayLike<number>,
  outflow?: Float64Array,
): number {
  let watts = 0;
  for (let pair = 0; pair * 2 + 1 < contact.nodePairs.length; pair++) {
    const a = contact.nodePairs[pair * 2];
    const b = contact.nodePairs[pair * 2 + 1];
    const flux = contactConductance(contact, pair) * (temperature[a] - temperature[b]);
    watts += flux;
    if (outflow) {
      outflow[a] += flux;
      outflow[b] -= flux;
    }
  }
  return watts;
}

export function computeHeatBalance(input: HeatBalanceInput): HeatBalance {
  const { model, scenario, temperature, conduction, fixedNodes, nodeLoad } = input;
  const partCount = model.parts.length;
  const convectionPerPart = new Float64Array(partCount);
  const radiationPerPart = new Float64Array(partCount);
  const injectedPerPart = new Float64Array(partCount);

  let lostByConvection = 0;
  let lostByRadiation = 0;
  let injectedAtLoads = 0;
  for (let node = 0; node < model.nodeCount; node++) {
    const part = model.nodePart[node];
    const convection = convectiveLoss(input, node);
    const radiation = radiativeLoss(input, node);
    convectionPerPart[part] += convection;
    radiationPerPart[part] += radiation;
    injectedPerPart[part] += nodeLoad[node];
    lostByConvection += convection;
    lostByRadiation += radiation;
    injectedAtLoads += nodeLoad[node];
  }

  // Net conductive outflow, accumulated only where it is needed: at fixed nodes.
  const outflow = new Float64Array(model.nodeCount);
  const perContact = scenario.contacts
    .filter((contact) => contact.enabled)
    .map((contact) => ({
      contactId: contact.id,
      watts: contactWatts(contact, temperature, outflow),
    }));

  const edgeCount = conduction.conductance.length;
  for (let edge = 0; edge < edgeCount; edge++) {
    const a = conduction.nodes[edge * 2];
    const b = conduction.nodes[edge * 2 + 1];
    const flux = conduction.conductance[edge] * (temperature[a] - temperature[b]);
    outflow[a] += flux;
    outflow[b] -= flux;
  }

  // At a pinned node the BC supplies whatever the node sheds by conduction and
  // from its own surface — into a cavity as readily as into the room — less any heat
  // load already delivered there. Summed over the fixed set, fixed-to-fixed conduction
  // cancels pairwise.
  let injectedAtFixed = 0;
  const counted = new Uint8Array(model.nodeCount);
  for (let i = 0; i < fixedNodes.length; i++) {
    const node = fixedNodes[i];
    if (node >= model.nodeCount || counted[node]) continue;
    counted[node] = 1;
    const injected =
      outflow[node] +
      convectiveLoss(input, node) +
      radiativeLoss(input, node) +
      cavityLoss(input, node) -
      nodeLoad[node];
    injectedAtFixed += injected;
    injectedPerPart[model.nodePart[node]] += injected;
  }

  const perPart = model.parts.map((part, index) => ({
    partId: part.id,
    convection: convectionPerPart[index],
    radiation: radiationPerPart[index],
    injected: injectedPerPart[index],
  }));

  return {
    injectedAtFixed,
    injectedAtLoads,
    lostByConvection,
    lostByRadiation,
    // Cavity exchange is absent from the losses above and cancels within each pocket, so
    // the residual keeps its meaning: what it now also catches is a cavity whose walls
    // do not agree about how much crossed them.
    residual: injectedAtFixed + injectedAtLoads - lostByConvection - lostByRadiation,
    perPart,
    perContact,
    perCavity: cavityNetFlow(input),
  };
}
