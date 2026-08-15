/**
 * What the last solve produced, as numbers.
 *
 * Warnings are at the top, in amber, before any of them: they mean the field may
 * not be trustworthy, and a warning in a console is a warning nobody reads. The
 * energy residual is shown next to the throughput it is judged against for the same
 * reason. The breakdowns — per part, per contact, by area, by path length — are
 * plots, and live in the dock.
 */

import { useEffect, useState } from 'react';
import { kelvinToCelsius } from '@/core/units';
import { heatThroughput } from '@/physics/solve';
import { Panel } from '../components/Panel';
import { EmptyState, Hint } from '../components/fields';
import { formatDuration, formatWatts } from '../state/format';
import { useProject } from '../state/projectStore';

export function ResultsPanel() {
  const { solve } = useProject();
  const tick = useTicker(solve.status === 'running');
  const result = solve.result;
  const balance = result?.balance;
  const throughput = balance ? heatThroughput(balance) : 0;
  const residualIsLarge = balance ? Math.abs(balance.residual) > 0.01 * throughput : false;

  return (
    <Panel
      title="Results"
      badge={solve.status === 'running' ? 'solving' : solve.stale ? 'stale' : undefined}
      tone={result && result.warnings.length > 0 ? 'warning' : 'default'}
    >
      {solve.status === 'running' ? (
        <p className="status">
          Solving… {formatDuration(solve.startedAt ? tick - solve.startedAt : 0)}
        </p>
      ) : null}
      {solve.error ? <p className="error">{solve.error}</p> : null}
      {!result && solve.status !== 'running' && !solve.error ? (
        <EmptyState>No solve yet.</EmptyState>
      ) : null}

      {result ? (
        <>
          {result.warnings.length > 0 ? (
            <ul className="warnings">
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          {solve.stale ? (
            <p className="status stale">
              The scenario has changed since this solve. Re-run to bring the field up to date.
            </p>
          ) : null}

          <dl className="stats">
            <div>
              <dt>range</dt>
              <dd>
                {kelvinToCelsius(result.minTemp).toFixed(1)} …{' '}
                {kelvinToCelsius(result.maxTemp).toFixed(1)} °C
              </dd>
            </div>
            <div>
              <dt>converged</dt>
              <dd>
                {result.converged ? 'yes' : 'no'} · {result.outerIterations} outer
              </dd>
            </div>
            <div>
              <dt>elapsed</dt>
              <dd>{formatDuration(result.elapsedMs)}</dd>
            </div>
          </dl>

          {balance ? (
            <dl className="stats">
              <div>
                <dt>at fixed temps</dt>
                <dd>{formatWatts(balance.injectedAtFixed)}</dd>
              </div>
              <div>
                <dt>at heat loads</dt>
                <dd>{formatWatts(balance.injectedAtLoads)}</dd>
              </div>
              <div>
                <dt>convection</dt>
                <dd>{formatWatts(balance.lostByConvection)}</dd>
              </div>
              <div>
                <dt>radiation</dt>
                <dd>{formatWatts(balance.lostByRadiation)}</dd>
              </div>
              <div className={residualIsLarge ? 'bad' : undefined}>
                <dt>residual</dt>
                <dd>
                  {formatWatts(balance.residual)}
                  {throughput > 0
                    ? ` (${((100 * Math.abs(balance.residual)) / throughput).toFixed(2)} % of ${formatWatts(throughput)})`
                    : ''}
                </dd>
              </div>
            </dl>
          ) : null}
          <Hint>
            Per part, per contact, area above a limit and temperature against path length are in the
            plots dock.
          </Hint>
        </>
      ) : null}
    </Panel>
  );
}

/** Re-renders while a solve runs so the elapsed time actually ticks. */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
