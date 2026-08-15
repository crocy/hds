import { describe, expect, it } from 'vitest';
import type { HeatBalance } from '@/core/types';
import { summariseHeatBalance } from './balanceSummary';

function balanceOf(overrides: Partial<HeatBalance> = {}): HeatBalance {
  return {
    injectedAtFixed: 61,
    injectedAtLoads: 0,
    lostByConvection: 40,
    lostByRadiation: 21,
    residual: 0,
    perPart: [],
    perContact: [],
    ...overrides,
  };
}

describe('summariseHeatBalance', () => {
  it('splits the loss by mechanism', () => {
    const summary = summariseHeatBalance(balanceOf());
    expect(summary.lost).toBe(61);
    expect(summary.injected).toBe(61);
    expect(summary.convectionShare).toBeCloseTo(40 / 61, 12);
    expect(summary.radiationShare).toBeCloseTo(21 / 61, 12);
    expect(summary.convectionShare + summary.radiationShare).toBeCloseTo(1, 12);
  });

  it('adds heat loads to the injected total', () => {
    expect(summariseHeatBalance(balanceOf({ injectedAtLoads: 5 })).injected).toBe(66);
  });

  it('reports no split when nothing is lost, rather than dividing by zero', () => {
    const summary = summariseHeatBalance(
      balanceOf({ lostByConvection: 0, lostByRadiation: 0, injectedAtFixed: 0 }),
    );
    expect(summary.convectionShare).toBe(0);
    expect(summary.radiationShare).toBe(0);
    expect(summary.residualFraction).toBe(0);
  });

  it('escalates the severity with the residual, relative to throughput', () => {
    expect(summariseHeatBalance(balanceOf({ residual: 0.01 })).severity).toBe('ok');
    expect(summariseHeatBalance(balanceOf({ residual: 0.5 })).severity).toBe('warn');
    expect(summariseHeatBalance(balanceOf({ residual: 20 })).severity).toBe('bad');
    expect(summariseHeatBalance(balanceOf({ residual: -20 })).severity).toBe('bad');
  });

  it('measures the residual against the larger of injected and lost', () => {
    const summary = summariseHeatBalance(balanceOf({ residual: 6.1 }));
    expect(summary.residualFraction).toBeCloseTo(0.1, 12);
  });

  it('treats a residual with no throughput behind it as untrustworthy', () => {
    const summary = summariseHeatBalance(
      balanceOf({ injectedAtFixed: 0, lostByConvection: 0, lostByRadiation: 0, residual: 3 }),
    );
    expect(summary.severity).toBe('bad');
  });

  it('sorts parts by magnitude and scales the bars to the busiest', () => {
    const summary = summariseHeatBalance(
      balanceOf({
        perPart: [
          { partId: 'lid', convection: 2, radiation: 1, injected: 0 },
          { partId: 'housing', convection: 30, radiation: 10, injected: 61 },
          { partId: 'bracket', convection: 8, radiation: 2, injected: 0 },
        ],
      }),
    );
    expect(summary.parts.map((part) => part.partId)).toEqual(['housing', 'bracket', 'lid']);
    expect(summary.parts[0].lost).toBe(40);
    expect(summary.parts[0].barFraction).toBe(1);
    expect(summary.parts[1].barFraction).toBeCloseTo(0.25, 12);
    expect(summary.parts[0].convectionFraction).toBeCloseTo(0.75, 12);
  });

  it('keeps a part that gains heat visible instead of collapsing its bar', () => {
    const summary = summariseHeatBalance(
      balanceOf({
        perPart: [
          { partId: 'hot', convection: 40, radiation: 0, injected: 0 },
          { partId: 'cold', convection: -20, radiation: 0, injected: 0 },
        ],
      }),
    );
    const cold = summary.parts.find((part) => part.partId === 'cold');
    expect(cold?.lost).toBe(-20);
    expect(cold?.barFraction).toBeCloseTo(0.5, 12);
  });

  it('sorts contacts by magnitude of flow, either direction', () => {
    const summary = summariseHeatBalance(
      balanceOf({
        perContact: [
          { contactId: 'a', watts: 2 },
          { contactId: 'b', watts: -9 },
          { contactId: 'c', watts: 5 },
        ],
      }),
    );
    expect(summary.contacts.map((contact) => contact.contactId)).toEqual(['b', 'c', 'a']);
    expect(summary.contacts[0].barFraction).toBe(1);
    expect(summary.contacts[2].barFraction).toBeCloseTo(2 / 9, 12);
  });

  it('survives an empty balance', () => {
    const summary = summariseHeatBalance(
      balanceOf({ injectedAtFixed: 0, lostByConvection: 0, lostByRadiation: 0 }),
    );
    expect(summary.parts).toEqual([]);
    expect(summary.contacts).toEqual([]);
    expect(summary.severity).toBe('ok');
  });
});
