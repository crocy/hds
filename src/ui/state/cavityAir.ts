/**
 * What the Cavities panel can say about the air trapped in each pocket.
 *
 * The solve gives the air a temperature of its own, and the balance re-adds the wall
 * flows from the solved field to report the net watts into each pocket. A sealed
 * pocket has nowhere to put them, so that number must come out ~0 — it is a check on
 * the answer rather than a restatement of it, which is why it is worth a user's
 * attention. On its own "4.7e-5 W" says nothing, so it is judged the way the global
 * residual is: as a share of the power the model actually moves. That yardstick is
 * the whole assembly's throughput rather than the traffic across this pocket's own
 * walls, which the balance does not report, so it flatters a small cavity in a busy
 * model; it is still the difference between "closed" and "leaking watts".
 */

import type { Cavity, HeatBalance } from '@/core/types';
import { heatThroughput } from '@/physics/solve';
import { residualSeverity, type ResidualSeverity } from '../plots/scales';

export type CavityAirState =
  | { kind: 'unsolved' }
  /** Adiabatic: it exchanges nothing, so the solve gives it no air node to report. */
  | { kind: 'noAirNode' }
  | {
      kind: 'solved';
      /** kelvin */
      temperature: number;
      /** Net watts in, signed: positive is heat the pocket gained and did not shed. */
      netFlow: number;
      /** Watts the model moves — what `netFlow` is judged against. Zero when it moves none. */
      throughput: number;
      /** |netFlow| over `throughput`, 0..1. Zero when there is no throughput. */
      flowFraction: number;
      severity: ResidualSeverity;
    };

/**
 * One state per cavity handed in, keyed by cavity id — including the ones the balance
 * says nothing about, which read as unsolved rather than as a pocket at 0 K.
 */
export function cavityAirStates(
  cavities: readonly Cavity[],
  balance: HeatBalance | null,
): Map<number, CavityAirState> {
  const throughput = balance ? meaningfulThroughput(balance) : 0;
  const solved = new Map(balance?.perCavity.map((entry) => [entry.cavityId, entry]) ?? []);

  const states = new Map<number, CavityAirState>();
  for (const cavity of cavities) {
    // Read from the live condition, not from the balance: switching a cavity to
    // adiabatic should stop claiming an air temperature straight away.
    if (cavity.condition === 'adiabatic') {
      states.set(cavity.id, { kind: 'noAirNode' });
      continue;
    }
    const entry = solved.get(cavity.id);
    if (!entry) {
      states.set(cavity.id, { kind: 'unsolved' });
      continue;
    }
    states.set(cavity.id, {
      kind: 'solved',
      temperature: entry.temperature,
      netFlow: entry.netFlow,
      throughput,
      flowFraction: throughput > 0 ? Math.abs(entry.netFlow) / throughput : 0,
      severity: residualSeverity(entry.netFlow, throughput),
    });
  }
  return states;
}

/**
 * A model shifting less than a milliwatt is not a heat problem, and a percentage of
 * it is noise: an isothermal assembly with no boundary conditions still moves a few
 * float ulps around, and "0.22 % of 0 mW" is not a sentence about anything.
 */
const NEGLIGIBLE_THROUGHPUT_WATTS = 1e-3;

function meaningfulThroughput(balance: HeatBalance): number {
  const watts = heatThroughput(balance);
  return watts >= NEGLIGIBLE_THROUGHPUT_WATTS ? watts : 0;
}

/** Below this a share is reported as a floor: the digits past it are solver noise. */
const SMALLEST_MEANINGFUL_SHARE = 1e-4;

/** A fraction of throughput as a percentage, e.g. `< 0.01 %` for a pocket that closed. */
export function formatShareOfThroughput(fraction: number): string {
  if (!Number.isFinite(fraction)) return '—';
  const magnitude = Math.abs(fraction);
  if (magnitude === 0) return '0 %';
  if (magnitude < SMALLEST_MEANINGFUL_SHARE) return '< 0.01 %';
  return `${(magnitude * 100).toFixed(2)} %`;
}
