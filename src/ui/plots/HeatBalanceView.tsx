/**
 * The heat balance readout — spec §7.3. Not a chart: a table of watts with two
 * stacked bars.
 *
 * The residual is the point of the panel. It is the difference between what went
 * in and what came out, and a large one means the solve is not physical, so it is
 * styled to escalate: quiet grey when negligible, amber when it drifts, and a red
 * block with a plain-language warning when the result should not be trusted.
 *
 * A pie chart would be the obvious thing for the convection/radiation split and
 * the wrong one — two quantities compared by angle, with no shared baseline, and
 * no room for the watts themselves.
 */

import type { HeatBalance } from '@/core/types';
import { summariseHeatBalance, type HeatBalanceSummary } from './balanceSummary';
import { formatPercent, formatWatts } from './format';
import { PLOT_COLORS } from './theme';
import './plots.css';

export interface HeatBalanceViewProps {
  balance: HeatBalance | null;
  /** partId → display name. Falls back to the id. */
  partNames?: Readonly<Record<string, string>>;
  /** contactId → display name. Falls back to the id. */
  contactNames?: Readonly<Record<string, string>>;
  className?: string;
}

export function HeatBalanceView({
  balance,
  partNames,
  contactNames,
  className,
}: HeatBalanceViewProps) {
  if (!balance) {
    return (
      <div className={className ? `hds-balance ${className}` : 'hds-balance'}>
        <p className="hds-balance__empty">
          No solve yet — the energy balance appears once a field has been computed.
        </p>
      </div>
    );
  }

  const summary = summariseHeatBalance(balance);

  return (
    <div className={className ? `hds-balance ${className}` : 'hds-balance'}>
      <div className="hds-balance__headline">
        <span className="hds-balance__total">{formatWatts(summary.lost)}</span>
        <span className="hds-balance__caption">
          total to ambient · {formatWatts(summary.injected)} injected
        </span>
      </div>

      <section className="hds-balance__section">
        <span className="hds-balance__heading">mechanism</span>
        <div className="hds-balance__bar">
          <span
            className="hds-balance__bar-segment"
            style={{
              width: `${summary.convectionShare * 100}%`,
              background: PLOT_COLORS.convection,
            }}
          />
          <span
            className="hds-balance__bar-segment"
            style={{
              width: `${summary.radiationShare * 100}%`,
              background: PLOT_COLORS.radiation,
            }}
          />
        </div>
        <div className="hds-balance__keys">
          <span className="hds-balance__key">
            <span className="hds-balance__dot" style={{ background: PLOT_COLORS.convection }} />
            convection {formatWatts(summary.convection)} ({formatPercent(summary.convectionShare)})
          </span>
          <span className="hds-balance__key">
            <span className="hds-balance__dot" style={{ background: PLOT_COLORS.radiation }} />
            radiation {formatWatts(summary.radiation)} ({formatPercent(summary.radiationShare)})
          </span>
        </div>
      </section>

      <ResidualBlock summary={summary} />

      {summary.parts.length > 0 && (
        <section className="hds-balance__section">
          <span className="hds-balance__heading">by part</span>
          <div className="hds-balance__table hds-balance__table--parts">
            {summary.parts.map((part) => (
              <PartRow
                key={part.partId}
                name={partNames?.[part.partId] ?? part.partId}
                part={part}
              />
            ))}
          </div>
        </section>
      )}

      {summary.contacts.length > 0 && (
        <section className="hds-balance__section">
          <span className="hds-balance__heading">across contacts</span>
          <div className="hds-balance__table hds-balance__table--contacts">
            {summary.contacts.map((contact) => (
              <div key={contact.contactId} style={{ display: 'contents' }}>
                <span className="hds-balance__name">
                  {contactNames?.[contact.contactId] ?? contact.contactId}
                </span>
                <span className="hds-balance__value">{formatWatts(contact.watts)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

interface PartRowProps {
  name: string;
  part: HeatBalanceSummary['parts'][number];
}

function PartRow({ name, part }: PartRowProps) {
  const convectionWidth = part.barFraction * part.convectionFraction * 100;
  const radiationWidth = part.barFraction * (1 - part.convectionFraction) * 100;
  return (
    <div style={{ display: 'contents' }}>
      <span className="hds-balance__name" title={name}>
        {name}
      </span>
      <span className="hds-balance__bar hds-balance__bar--thin">
        <span
          className="hds-balance__bar-segment"
          style={{ width: `${convectionWidth}%`, background: PLOT_COLORS.convection }}
        />
        <span
          className="hds-balance__bar-segment"
          style={{ width: `${radiationWidth}%`, background: PLOT_COLORS.radiation }}
        />
      </span>
      <span className="hds-balance__value">{formatWatts(part.lost)}</span>
    </div>
  );
}

const RESIDUAL_MESSAGE = {
  ok: 'energy is conserved',
  warn: 'energy balance is drifting — tighten the solver tolerance',
  bad: 'energy is not conserved — do not trust this result',
} as const;

function ResidualBlock({ summary }: { summary: HeatBalanceSummary }) {
  return (
    <div className={`hds-balance__residual hds-balance__residual--${summary.severity}`}>
      <span className="hds-balance__heading">residual</span>
      <span className="hds-balance__residual-value">{formatWatts(summary.residual)}</span>
      <span>{formatPercent(summary.residualFraction, 2)} of throughput</span>
      <span className="hds-balance__residual-note">{RESIDUAL_MESSAGE[summary.severity]}</span>
    </div>
  );
}
