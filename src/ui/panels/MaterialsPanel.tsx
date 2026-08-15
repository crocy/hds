/**
 * Material and finish for the selected parts, from the library or typed in by hand.
 *
 * Emissivity is a property of the finish, not the material, because the same steel
 * painted loses several times the radiative power of the bare one.
 */

import { useState } from 'react';
import type { Material, SurfaceFinish } from '@/core/types';
import { Panel } from '../components/Panel';
import { EmptyState, Hint, NumberField, SelectField } from '../components/fields';
import { createCustomFinish, createCustomMaterial } from '../state/entityFactories';
import { allFinishes, allMaterials, upsertFinish, upsertMaterial } from '../state/materialLibrary';
import { useDispatch, useProject } from '../state/projectStore';
import { commonValue, partRows, selectedPartIds } from '../state/selectors';

export function MaterialsPanel() {
  const { model, scenario, viewer, custom } = useProject();
  const dispatch = useDispatch();
  const [customName, setCustomName] = useState('Custom material');
  const [customK, setCustomK] = useState(1);
  const [customEmissivity, setCustomEmissivity] = useState(0.5);

  const selectedIds = selectedPartIds(viewer.selection);
  const selectedSet = new Set(selectedIds);
  const rows = partRows(model, scenario).filter((row) => selectedSet.has(row.part.id));
  const materials = allMaterials(custom);
  const finishes = allFinishes(custom);

  const materialId = commonValue(rows, (row) => row.materialId);
  const finishId = commonValue(rows, (row) => row.finishId);
  const material = materials.find((entry) => entry.id === materialId);
  const finish = finishes.find((entry) => entry.id === finishId);

  const assign = (patch: { materialId?: string; finishId?: string }) => {
    if (selectedIds.length === 0) return;
    dispatch({ type: 'parts/patchOverride', partIds: selectedIds, patch });
  };

  const addCustom = () => {
    const newMaterial = createCustomMaterial(customName || 'Custom material', customK);
    const newFinish = createCustomFinish(`${customName || 'Custom'} surface`, customEmissivity);
    const library = upsertFinish(upsertMaterial(custom, newMaterial), newFinish);
    dispatch({ type: 'library/set', custom: library });
    assign({ materialId: newMaterial.id, finishId: newFinish.id });
  };

  return (
    <Panel
      title="Materials"
      defaultOpen={false}
      badge={rows.length ? `${rows.length} sel` : undefined}
    >
      {rows.length === 0 ? (
        <EmptyState>Select a part to set its material.</EmptyState>
      ) : (
        <>
          <SelectField
            label="material"
            value={materialId ?? ''}
            options={[
              ...(materialId === null ? [{ value: '', label: '— mixed —' }] : []),
              ...materials.map((entry) => ({
                value: entry.id,
                label: `${entry.name} · k = ${entry.k} W/m·K`,
                group: entry.category,
              })),
            ]}
            onChange={(value) => value && assign({ materialId: value })}
          />
          <SelectField
            label="finish"
            value={finishId ?? ''}
            options={[
              ...(finishId === null ? [{ value: '', label: '— mixed —' }] : []),
              ...finishes.map((entry) => ({
                value: entry.id,
                label: `${entry.name} · ε = ${entry.emissivity}`,
              })),
            ]}
            onChange={(value) => value && assign({ finishId: value })}
          />
          <Hint>
            {describeResolved(material, finish)} Applied to{' '}
            {rows.length === 1 ? rows[0].part.name : `${rows.length} parts`}.
          </Hint>

          <div className="editor">
            <div className="editor-title">custom material</div>
            <label className="field">
              <span className="field-label">name</span>
              <span className="field-input">
                <input
                  type="text"
                  value={customName}
                  onChange={(event) => setCustomName(event.target.value)}
                />
              </span>
            </label>
            <NumberField
              label="k"
              suffix="W/m·K"
              min={1e-4}
              value={customK}
              onCommit={setCustomK}
              title="Thermal conductivity"
            />
            <NumberField
              label="emissivity"
              min={0}
              max={1}
              step={0.05}
              value={customEmissivity}
              onCommit={setCustomEmissivity}
              title="Hemispherical total emissivity of the surface"
            />
            <button type="button" onClick={addCustom}>
              add and apply
            </button>
            <Hint>
              Custom entries are saved with the project and travel to the solver with each run.
            </Hint>
          </div>
        </>
      )}
    </Panel>
  );
}

function describeResolved(
  material: Material | undefined,
  finish: SurfaceFinish | undefined,
): string {
  if (!material || !finish) return 'Parts have different materials or finishes.';
  return `k = ${material.k} W/m·K, ε = ${finish.emissivity}.`;
}
