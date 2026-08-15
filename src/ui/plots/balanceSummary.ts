/**
 * Turns a `HeatBalance` into the rows and fractions the readout draws.
 *
 * Pure, and separate from the component, because the judgement it encodes — how
 * big a residual has to be before a result should not be trusted — is the part
 * worth testing.
 */

import type { HeatBalance } from '@/core/types';
import { residualSeverity, stackSegments, type ResidualSeverity } from './scales';

export interface BalancePartRow {
  partId: string;
  convection: number;
  radiation: number;
  injected: number;
  /** convection + radiation: what this part sheds to ambient. */
  lost: number;
  /** Fraction of the largest part's magnitude, 0..1 — the bar's width. */
  barFraction: number;
  /** Where convection ends and radiation begins within this part's bar, 0..1. */
  convectionFraction: number;
}

export interface BalanceContactRow {
  contactId: string;
  watts: number;
  /** Fraction of the largest |watts|, 0..1. */
  barFraction: number;
}

export interface HeatBalanceSummary {
  injected: number;
  lost: number;
  convection: number;
  radiation: number;
  /** Share of the loss carried by each mechanism, 0..1. Zero when nothing is lost. */
  convectionShare: number;
  radiationShare: number;
  residual: number;
  severity: ResidualSeverity;
  /** |residual| as a fraction of the power moving through the model. */
  residualFraction: number;
  parts: BalancePartRow[];
  contacts: BalanceContactRow[];
}

export function summariseHeatBalance(balance: HeatBalance): HeatBalanceSummary {
  const injected = balance.injectedAtFixed + balance.injectedAtLoads;
  const convection = balance.lostByConvection;
  const radiation = balance.lostByRadiation;
  const lost = convection + radiation;

  const mechanismTotal = Math.abs(convection) + Math.abs(radiation);
  const convectionShare = mechanismTotal > 0 ? Math.abs(convection) / mechanismTotal : 0;

  const reference = Math.max(Math.abs(injected), Math.abs(lost));
  const residualFraction = reference > 0 ? Math.abs(balance.residual) / reference : 0;

  const parts = buildPartRows(balance);
  const contacts = buildContactRows(balance);

  return {
    injected,
    lost,
    convection,
    radiation,
    convectionShare,
    radiationShare: mechanismTotal > 0 ? 1 - convectionShare : 0,
    residual: balance.residual,
    severity: residualSeverity(balance.residual, reference),
    residualFraction,
    parts,
    contacts,
  };
}

function buildPartRows(balance: HeatBalance): BalancePartRow[] {
  const rows = balance.perPart.map((part) => {
    const lost = part.convection + part.radiation;
    const [convectionSegment] = stackSegments([part.convection, part.radiation]);
    return {
      partId: part.partId,
      convection: part.convection,
      radiation: part.radiation,
      injected: part.injected,
      lost,
      barFraction: 0,
      convectionFraction: convectionSegment ? convectionSegment.end : 0,
    };
  });

  // Bars are scaled to the busiest part, not to the assembly total: with 30 parts
  // a share-of-total bar would be invisible for all but one or two of them.
  let peak = 0;
  for (const row of rows) peak = Math.max(peak, Math.abs(row.lost));
  if (peak > 0) for (const row of rows) row.barFraction = Math.abs(row.lost) / peak;

  return rows.sort((a, b) => Math.abs(b.lost) - Math.abs(a.lost));
}

function buildContactRows(balance: HeatBalance): BalanceContactRow[] {
  let peak = 0;
  for (const contact of balance.perContact) peak = Math.max(peak, Math.abs(contact.watts));
  return balance.perContact
    .map((contact) => ({
      contactId: contact.contactId,
      watts: contact.watts,
      barFraction: peak > 0 ? Math.abs(contact.watts) / peak : 0,
    }))
    .sort((a, b) => Math.abs(b.watts) - Math.abs(a.watts));
}
