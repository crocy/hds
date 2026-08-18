/**
 * The analysis dock: the four plots of the design's §7, mounted from `@/ui/plots`.
 *
 * The plot components are pure and presentational, so this is where the analysis
 * actually runs. Each result is computed only for the tab that is showing —
 * Dijkstra over the whole conduction graph is not something to run because a panel
 * happens to be open.
 */

import { useMemo, useState } from 'react';
import { analysePathLength } from '@/analysis/pathLength';
import { areaAboveThreshold } from '@/analysis/threshold';
import type { Scenario, SectionField2D, SolveResult, ThermalModel } from '@/core/types';
import type { SectionPolylineDetail } from '@/geometry/section';
import { celsiusToKelvin } from '@/core/units';
import { unionTargetNodes } from '@/physics/assemble';
import {
  HeatBalanceView,
  PathLengthPlot,
  SectionFieldPlot,
  SectionProfilePlot,
  ThresholdPlot,
} from '@/ui/plots';
import type { ResolvedColorScale } from '@/viewer';
import { NumberField } from '../components/fields';

/** Cut outlines and the field solved on the same plane, as the viewer has them. */
export interface SectionSlice {
  polylines: SectionPolylineDetail[];
  field: SectionField2D | null;
  /** In-plane axis names, for the field plot's captions. */
  uLabel: string;
  vLabel: string;
}

export interface PlotsDockProps {
  model: ThermalModel | null;
  scenario: Scenario;
  result: SolveResult | null;
  section: SectionSlice | null;
  scale: ResolvedColorScale;
  onClose(): void;
}

type Tab = 'profile' | 'field' | 'path' | 'area' | 'balance';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'profile', label: 'section profile' },
  { id: 'field', label: 'cut plane' },
  { id: 'path', label: 'path length' },
  { id: 'area', label: 'area above limit' },
  { id: 'balance', label: 'heat balance' },
];

export function PlotsDock({ model, scenario, result, section, scale, onClose }: PlotsDockProps) {
  const [tab, setTab] = useState<Tab>('profile');
  const [limitC, setLimitC] = useState(55);
  const limit = celsiusToKelvin(limitC);

  const partNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const part of model?.parts ?? []) names[part.id] = part.name;
    return names;
  }, [model]);

  const threshold = useMemo(() => {
    if (tab !== 'area' || !model || !result) return null;
    return areaAboveThreshold(model, result.temperature, limit);
  }, [tab, model, result, limit]);

  const pathLength = useMemo(() => {
    if (tab !== 'path' || !model || !result) return null;
    const sources = new Set<number>();
    for (const condition of scenario.boundaryConditions) {
      if (condition.kind !== 'fixedTemp' || !condition.enabled) continue;
      for (const node of unionTargetNodes(model, condition.targets)) sources.add(node);
    }
    if (sources.size === 0) return null;
    return analysePathLength(model, sources, result.temperature, {
      contacts: scenario.contacts,
      tInfinity: scenario.ambient,
    });
  }, [tab, model, result, scenario.boundaryConditions, scenario.contacts, scenario.ambient]);

  const colorRange: [number, number] = [scale.min, scale.max];

  return (
    <section className="panel plots-dock">
      <header>
        <div className="button-group">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={tab === entry.id ? 'on' : undefined}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {tab === 'area' || tab === 'profile' ? (
          <NumberField label="limit" suffix="°C" value={limitC} onCommit={setLimitC} />
        ) : null}
        <button type="button" className="mini" title="close" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="plots-body">
        {tab === 'profile' ? (
          <SectionProfilePlot
            polylines={section?.polylines ?? []}
            partNames={partNames}
            threshold={limit}
            thresholdLabel={`${limitC.toFixed(0)} °C limit`}
            height="100%"
          />
        ) : null}
        {tab === 'field' ? (
          <SectionFieldPlot
            field={section?.field ?? null}
            colorMap={scale.map}
            range={colorRange}
            uLabel={section?.uLabel ?? 'U  [mm]'}
            vLabel={section?.vLabel ?? 'V  [mm]'}
            height="100%"
          />
        ) : null}
        {tab === 'path' ? (
          <PathLengthPlot
            result={pathLength}
            temperature={result?.temperature ?? null}
            colorMap={scale.map}
            colorRange={colorRange}
            threshold={limit}
            height="100%"
          />
        ) : null}
        {tab === 'area' ? (
          <ThresholdPlot
            result={threshold}
            colorMap={scale.map}
            colorRange={colorRange}
            partNames={partNames}
            height="100%"
          />
        ) : null}
        {tab === 'balance' ? (
          <HeatBalanceView balance={result?.balance ?? null} partNames={partNames} />
        ) : null}
      </div>
    </section>
  );
}
