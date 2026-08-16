import { describe, expect, it } from 'vitest';
import type { Cavity, HeatBalance } from '@/core/types';
import { cavityAirStates, formatShareOfThroughput } from './cavityAir';

function cavityOf(id: number, overrides: Partial<Cavity> = {}): Cavity {
  return {
    id,
    name: `cavity ${id}`,
    condition: 'stillAir',
    h: 3,
    emissivity: 0.85,
    fillK: 0.026,
    triCount: 120,
    ...overrides,
  };
}

/** 61 W of throughput, so a net flow reads as a share of a round number. */
function balanceOf(overrides: Partial<HeatBalance> = {}): HeatBalance {
  return {
    injectedAtFixed: 61,
    injectedAtLoads: 0,
    lostByConvection: 40,
    lostByRadiation: 21,
    residual: 0,
    perPart: [],
    perContact: [],
    perCavity: [],
    ...overrides,
  };
}

describe('cavityAirStates', () => {
  it('has no temperature to report for any cavity before a solve', () => {
    const states = cavityAirStates([cavityOf(1), cavityOf(2)], null);
    expect(states.get(1)).toEqual({ kind: 'unsolved' });
    expect(states.get(2)).toEqual({ kind: 'unsolved' });
  });

  it('reports the solved air temperature and how nearly the pocket balanced', () => {
    const states = cavityAirStates(
      [cavityOf(1)],
      balanceOf({ perCavity: [{ cavityId: 1, temperature: 320.15, netFlow: 4.7e-5 }] }),
    );
    expect(states.get(1)).toEqual({
      kind: 'solved',
      temperature: 320.15,
      netFlow: 4.7e-5,
      throughput: 61,
      flowFraction: 4.7e-5 / 61,
      severity: 'ok',
    });
  });

  it('measures the net flow against the power the model actually moves', () => {
    const states = cavityAirStates(
      [cavityOf(1)],
      balanceOf({
        lostByConvection: 0,
        lostByRadiation: 0,
        perContact: [{ contactId: 'a', watts: 20 }],
        perCavity: [{ cavityId: 1, temperature: 300, netFlow: 2 }],
      }),
    );
    const state = states.get(1);
    expect(state?.kind).toBe('solved');
    expect(state).toMatchObject({ flowFraction: 0.1, severity: 'bad' });
  });

  it('escalates the severity with the net flow', () => {
    const severityOf = (netFlow: number) => {
      const states = cavityAirStates(
        [cavityOf(1)],
        balanceOf({ perCavity: [{ cavityId: 1, temperature: 300, netFlow }] }),
      );
      const state = states.get(1);
      return state?.kind === 'solved' ? state.severity : null;
    };
    expect(severityOf(1e-6)).toBe('ok');
    expect(severityOf(0.5)).toBe('warn');
    expect(severityOf(-20)).toBe('bad');
  });

  it('keeps the direction of the net flow while judging its size', () => {
    const states = cavityAirStates(
      [cavityOf(1)],
      balanceOf({ perCavity: [{ cavityId: 1, temperature: 300, netFlow: -6.1 }] }),
    );
    const state = states.get(1);
    expect(state).toMatchObject({ netFlow: -6.1 });
    expect(state?.kind === 'solved' ? state.flowFraction : null).toBeCloseTo(0.1, 12);
  });

  it('says an adiabatic cavity has no air node, solve or no solve', () => {
    const cavities = [cavityOf(1, { condition: 'adiabatic' })];
    expect(cavityAirStates(cavities, null).get(1)).toEqual({ kind: 'noAirNode' });
    expect(
      cavityAirStates(
        cavities,
        balanceOf({ perCavity: [{ cavityId: 1, temperature: 300, netFlow: 0 }] }),
      ).get(1),
    ).toEqual({ kind: 'noAirNode' });
  });

  it('reads a cavity the balance never mentioned as unsolved, not as 0 K', () => {
    const states = cavityAirStates(
      [cavityOf(1), cavityOf(2)],
      balanceOf({ perCavity: [{ cavityId: 1, temperature: 320, netFlow: 0 }] }),
    );
    expect(states.get(2)).toEqual({ kind: 'unsolved' });
  });

  it('has an entry for every cavity it was handed and no others', () => {
    const states = cavityAirStates(
      [cavityOf(1), cavityOf(2, { condition: 'adiabatic' })],
      balanceOf({
        perCavity: [
          { cavityId: 1, temperature: 320, netFlow: 0 },
          { cavityId: 7, temperature: 310, netFlow: 0 },
        ],
      }),
    );
    expect([...states.keys()]).toEqual([1, 2]);
  });

  it('quotes no throughput to judge against when the model barely moves any power', () => {
    const states = cavityAirStates(
      [cavityOf(1)],
      balanceOf({
        injectedAtFixed: 2e-5,
        lostByConvection: 1e-5,
        lostByRadiation: 1e-5,
        perCavity: [{ cavityId: 1, temperature: 293.15, netFlow: 1e-12 }],
      }),
    );
    expect(states.get(1)).toMatchObject({ throughput: 0, flowFraction: 0, severity: 'ok' });
  });

  it('trusts nothing when a pocket leaks watts a still model has nowhere to get', () => {
    const states = cavityAirStates(
      [cavityOf(1)],
      balanceOf({
        injectedAtFixed: 0,
        lostByConvection: 0,
        lostByRadiation: 0,
        perCavity: [{ cavityId: 1, temperature: 300, netFlow: 3 }],
      }),
    );
    expect(states.get(1)).toMatchObject({ severity: 'bad', flowFraction: 0 });
  });
});

describe('formatShareOfThroughput', () => {
  it('floors a vanishing share instead of printing a row of zeroes', () => {
    expect(formatShareOfThroughput(4.7e-5 / 61)).toBe('< 0.01 %');
  });

  it('prints a share that matters to two decimals', () => {
    expect(formatShareOfThroughput(0.034)).toBe('3.40 %');
    expect(formatShareOfThroughput(0.0001)).toBe('0.01 %');
  });

  it('prints an exact zero as zero rather than as a floor', () => {
    expect(formatShareOfThroughput(0)).toBe('0 %');
  });

  it('prints a share it cannot compute as a dash', () => {
    expect(formatShareOfThroughput(Number.NaN)).toBe('—');
  });
});
