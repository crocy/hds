/**
 * Import progress, import failures, and the entities a loaded project could not bind
 * to the geometry.
 *
 * A 7 MB wasm kernel plus tessellation is seconds, not milliseconds, so the progress
 * card names the stage it is on. Failures are shown in full: a corrupt STEP has to
 * say so, not leave a black screen.
 */

import { useEffect, useState } from 'react';
import { IMPORT_STAGE_LABELS } from '@/io/importPipeline';
import { formatDuration } from '../state/format';
import { useDispatch, useProject } from '../state/projectStore';

export function StatusOverlay() {
  const { import: importState, issues } = useProject();
  const dispatch = useDispatch();
  const now = useTicker(importState.status === 'running');

  return (
    <>
      {importState.status === 'running' ? (
        <div className="modal-backdrop">
          <div className="panel modal progress">
            <h2>Importing {importState.filename}</h2>
            <div className="bar-track">
              <div className="bar-fill" />
            </div>
            <p className="muted">
              {importState.stage ? IMPORT_STAGE_LABELS[importState.stage] : 'starting'} ·{' '}
              {formatDuration(importState.startedAt ? now - importState.startedAt : 0)}
            </p>
          </div>
        </div>
      ) : null}

      {importState.status === 'error' && importState.error ? (
        <div className="modal-backdrop">
          <div className="panel modal">
            <h2>Could not import {importState.filename}</h2>
            <p className="error">{importState.error}</p>
            <div className="row end">
              <button type="button" onClick={() => dispatch({ type: 'import/dismiss' })}>
                close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {issues.length > 0 ? (
        <div className="panel issues">
          <header>
            <strong>{issues.length} unresolved</strong>
            <button type="button" onClick={() => dispatch({ type: 'project/dismissIssues' })}>
              dismiss
            </button>
          </header>
          <ul>
            {issues.map((issue, index) => (
              <li key={`${issue.kind}-${issue.id}-${index}`}>
                <span className="muted">{issue.kind}</span> {issue.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
