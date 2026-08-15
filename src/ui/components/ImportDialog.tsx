/**
 * The options a CAD file needs before it can be read.
 *
 * STEP carries units and B-rep faces but not a mesh, so the question is tessellation
 * quality. STL and OBJ carry a mesh but no units at all, so the question is what the
 * numbers in the file mean — get that wrong and every area, and therefore every watt,
 * is off by a factor of a thousand.
 */

import type { LengthUnit } from '@/core/units';
import { LENGTH_UNITS } from '@/core/units';
import type { ImportFormat } from '@/geometry/importers';
import {
  TESSELLATION_PRESETS,
  type ImportSettings,
  type TessellationQuality,
} from '@/io/importPipeline';
import { ButtonGroup, CheckField, Hint, NumberField } from './fields';

export interface ImportDialogProps {
  filename: string;
  sizeBytes: number;
  format: ImportFormat;
  settings: ImportSettings;
  onChange(patch: Partial<ImportSettings>): void;
  onCancel(): void;
  onConfirm(): void;
}

const QUALITIES: ReadonlyArray<{ value: TessellationQuality; label: string }> = [
  { value: 'coarse', label: 'coarse' },
  { value: 'normal', label: 'normal' },
  { value: 'fine', label: 'fine' },
];

export function ImportDialog({
  filename,
  sizeBytes,
  format,
  settings,
  onChange,
  onCancel,
  onConfirm,
}: ImportDialogProps) {
  const preset = TESSELLATION_PRESETS[settings.quality];
  return (
    <div className="modal-backdrop">
      <div className="panel modal">
        <h2>Import {format.toUpperCase()}</h2>
        <p className="muted">
          {filename} · {(sizeBytes / 1024 / 1024).toFixed(2)} MB
        </p>

        {format === 'step' ? (
          <>
            <div className="row spread">
              <span className="field-label">tessellation</span>
              <ButtonGroup
                value={settings.quality}
                options={QUALITIES}
                onChange={(quality) => onChange({ quality })}
              />
            </div>
            <Hint>
              Chord error {(preset.linearDeflection * 100).toFixed(3)} % of the bounding box,{' '}
              {preset.angularDeflection}° angular. Finer meshes resolve small features and cost
              solve time.
            </Hint>
          </>
        ) : (
          <>
            <div className="row spread">
              <span className="field-label">units in the file</span>
              <ButtonGroup
                value={settings.units}
                options={LENGTH_UNITS.map((unit: LengthUnit) => ({ value: unit, label: unit }))}
                onChange={(units) => onChange({ units })}
              />
            </div>
            <Hint>
              {format.toUpperCase()} carries no units; this is an assumption, not a reading.
            </Hint>
          </>
        )}

        <CheckField
          label="detect enclosed cavities"
          checked={settings.detectCavities}
          onChange={(detectCavities) => onChange({ detectCavities })}
        />
        <CheckField
          label="detect contacts between parts"
          checked={settings.detectContacts}
          onChange={(detectContacts) => onChange({ detectContacts })}
        />
        <NumberField
          label="contact gap"
          suffix="mm"
          min={0.001}
          step={0.1}
          value={settings.contactTolerance * 1000}
          disabled={!settings.detectContacts}
          onCommit={(mm) => onChange({ contactTolerance: mm / 1000 })}
          title="Surfaces closer than this are treated as touching"
        />

        <div className="row end">
          <button type="button" onClick={onCancel}>
            cancel
          </button>
          <button type="button" className="primary" onClick={onConfirm}>
            import
          </button>
        </div>
      </div>
    </div>
  );
}
