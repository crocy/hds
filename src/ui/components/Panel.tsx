/**
 * A collapsible panel section, in the prototype's translucent style.
 *
 * Open state is local: which panels a user has folded away is not worth persisting
 * and is certainly not part of the scenario.
 */

import { useState, type ReactNode } from 'react';

export interface PanelProps {
  title: string;
  /** A count or a status word, shown next to the title. */
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  /** Rendered in the header, right-aligned; clicks do not toggle the panel. */
  actions?: ReactNode;
  tone?: 'default' | 'warning';
}

export function Panel({
  title,
  badge,
  defaultOpen = true,
  children,
  actions,
  tone = 'default',
}: PanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`panel-section${tone === 'warning' ? ' warning' : ''}`}>
      <header>
        <button type="button" className="panel-toggle" onClick={() => setOpen(!open)}>
          <span className={`chevron${open ? ' open' : ''}`} aria-hidden="true" />
          <span className="panel-title">{title}</span>
          {badge !== undefined && badge !== null ? <span className="badge">{badge}</span> : null}
        </button>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      {open ? <div className="panel-body">{children}</div> : null}
    </section>
  );
}
