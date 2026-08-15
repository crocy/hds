/**
 * The part tree: what the assembly is made of, and the multi-part editor.
 *
 * `thinnessRatio` and the imported guess are shown next to the body type on purpose
 * — the guess decides whether a part conducts as a sheet or a lump, and a user who
 * cannot see why it was made cannot tell when it is wrong.
 */

import type { BodyType, PartOverride, Target } from '@/core/types';
import { applySelection } from '@/viewer';
import { Panel } from '../components/Panel';
import { ButtonGroup, EmptyState, Hint, NumberField, SliderField } from '../components/fields';
import { formatMillimetres } from '../state/format';
import { useDispatch, useProject } from '../state/projectStore';
import { commonValue, partRows, selectedPartIds } from '../state/selectors';

const BODY_TYPES: ReadonlyArray<{ value: BodyType; label: string; title: string }> = [
  {
    value: 'sheet',
    label: 'sheet',
    title: 'Conducts through a thickness; convects from both faces',
  },
  { value: 'lump', label: 'lump', title: 'Chunky solid; the shell mesh carries its surface' },
  { value: 'insulator', label: 'insulator', title: 'Left out of the solve entirely' },
];

export function PartTreePanel() {
  const { model, scenario, viewer } = useProject();
  const dispatch = useDispatch();
  const rows = partRows(model, scenario);
  const selectedIds = selectedPartIds(viewer.selection);
  const selectedSet = new Set(selectedIds);
  const selectedRows = rows.filter((row) => selectedSet.has(row.part.id));
  const allPartIds = rows.map((row) => row.part.id);

  const selectPart = (partId: string, additive: boolean) => {
    const target: Target = { type: 'part', partId };
    dispatch({
      type: 'view/setSelection',
      selection: applySelection(viewer.selection, target, additive),
    });
  };

  const patchParts = (partIds: readonly string[], patch: PartOverride) => {
    if (partIds.length === 0) return;
    dispatch({ type: 'parts/patchOverride', partIds, patch });
  };
  const patchSelected = (patch: PartOverride) => patchParts(selectedIds, patch);

  return (
    <Panel
      title="Parts"
      badge={rows.length || undefined}
      actions={
        <>
          <button
            type="button"
            onClick={() => dispatch({ type: 'parts/showAll', allPartIds })}
            disabled={rows.length === 0}
          >
            show all
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'parts/clearOverride', partIds: allPartIds })}
            disabled={rows.length === 0}
          >
            reset
          </button>
        </>
      }
    >
      {rows.length === 0 ? (
        <EmptyState>No model loaded.</EmptyState>
      ) : (
        <>
          <ul className="part-list">
            {rows.map((row) => (
              <li
                key={row.part.id}
                className={selectedSet.has(row.part.id) ? 'part-row selected' : 'part-row'}
              >
                <input
                  type="checkbox"
                  checked={row.visible}
                  title="visible"
                  onChange={(event) => patchParts([row.part.id], { visible: event.target.checked })}
                />
                <button
                  type="button"
                  className="part-name"
                  onClick={(event) => selectPart(row.part.id, event.shiftKey || event.ctrlKey)}
                  title={`${row.part.name} · ${row.part.triRange[1] - row.part.triRange[0]} triangles`}
                >
                  <span className="name">{row.part.name}</span>
                  <span className="muted">
                    {row.bodyType}
                    {row.bodyType !== row.part.bodyType ? ` (was ${row.part.bodyType})` : ''} ·
                    ratio {row.part.thinnessRatio.toFixed(3)} · {row.materialName} ·{' '}
                    {formatMillimetres(row.thickness)}
                  </span>
                </button>
                <button
                  type="button"
                  className="mini"
                  title="hide everything else"
                  onClick={() =>
                    dispatch({ type: 'parts/isolate', partIds: [row.part.id], allPartIds })
                  }
                >
                  iso
                </button>
              </li>
            ))}
          </ul>

          {selectedRows.length === 0 ? (
            <Hint>Click a part to edit it. Shift-click adds to the selection.</Hint>
          ) : (
            <div className="editor">
              <div className="editor-title">
                editing{' '}
                {selectedRows.length === 1
                  ? selectedRows[0].part.name
                  : `${selectedRows.length} parts`}
              </div>
              <ButtonGroup
                value={(commonValue(selectedRows, (row) => row.bodyType) ?? 'sheet') as BodyType}
                options={BODY_TYPES}
                onChange={(bodyType) => patchSelected({ bodyType })}
              />
              <NumberField
                label="thickness"
                suffix="mm"
                min={0}
                step={0.1}
                value={(commonValue(selectedRows, (row) => row.thickness) ?? 0) * 1000}
                onCommit={(mm) => patchSelected({ thickness: mm / 1000 })}
                title="Sheet thickness. Import reads it from the solid's volume and area where it can."
              />
              <SliderField
                label="opacity"
                min={0.05}
                max={1}
                step={0.05}
                value={commonValue(selectedRows, (row) => row.opacity) ?? 1}
                onChange={(opacity) => patchSelected({ opacity })}
              />
              <div className="row">
                <button
                  type="button"
                  onClick={() =>
                    dispatch({ type: 'parts/isolate', partIds: selectedIds, allPartIds })
                  }
                >
                  isolate
                </button>
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'parts/clearOverride', partIds: selectedIds })}
                >
                  reset these
                </button>
              </div>
              <Hint>
                surface{' '}
                {selectedRows.map((row) => (row.part.surfaceArea * 1e4).toFixed(1)).join(', ')} cm²
              </Hint>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
