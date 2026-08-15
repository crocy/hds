/**
 * Derivations the panels share: what the current selection means, and what a part
 * will actually be solved with once its override is applied.
 */

import type { Part, PartOverride, Scenario, Target, ThermalModel } from '@/core/types';
import { describeFinish, describeMaterial } from './materialLibrary';

/** Unique part ids named by the selection, whatever granularity it was made at. */
export function selectedPartIds(selection: readonly Target[]): string[] {
  const ids: string[] = [];
  for (const target of selection) {
    if (!ids.includes(target.partId)) ids.push(target.partId);
  }
  return ids;
}

export interface ResolvedPartRow {
  part: Part;
  override: PartOverride | undefined;
  bodyType: Part['bodyType'];
  materialId: string;
  materialName: string;
  /** W/(m·K) */
  k: number;
  finishId: string;
  finishName: string;
  emissivity: number;
  /** Metres. */
  thickness: number;
  visible: boolean;
  opacity: number;
  /** True when the property differs from what import guessed. */
  overridden: boolean;
}

export function resolvePartRow(part: Part, override: PartOverride | undefined): ResolvedPartRow {
  const materialId = override?.materialId ?? part.materialId;
  const finishId = override?.finishId ?? part.finishId;
  const material = describeMaterial(materialId);
  const finish = describeFinish(finishId);
  return {
    part,
    override,
    bodyType: override?.bodyType ?? part.bodyType,
    materialId,
    materialName: material.name,
    k: material.k,
    finishId,
    finishName: finish.name,
    emissivity: finish.emissivity,
    thickness: override?.thickness ?? part.thickness,
    visible: override?.visible !== false,
    opacity: override?.opacity ?? 1,
    overridden:
      override !== undefined &&
      (override.bodyType !== undefined ||
        override.materialId !== undefined ||
        override.finishId !== undefined ||
        override.thickness !== undefined),
  };
}

export function partRows(model: ThermalModel | null, scenario: Scenario): ResolvedPartRow[] {
  if (!model) return [];
  return model.parts.map((part) => resolvePartRow(part, scenario.partOverrides[part.id]));
}

export function partNameOf(model: ThermalModel | null, partId: string): string {
  return model?.parts.find((part) => part.id === partId)?.name ?? partId;
}

/**
 * The one value shared by a set of rows, or null when they disagree — so a
 * multi-part editor can show "mixed" instead of pretending they all match the first.
 */
export function commonValue<T>(
  rows: readonly ResolvedPartRow[],
  read: (row: ResolvedPartRow) => T,
): T | null {
  if (rows.length === 0) return null;
  const first = read(rows[0]);
  return rows.every((row) => read(row) === first) ? first : null;
}
