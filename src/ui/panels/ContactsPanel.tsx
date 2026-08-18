/**
 * Contacts — the only path heat has between parts, since nodes are never welded
 * across them.
 *
 * One row per joint, not per patch: detection splits a joint into one patch per place
 * the parts touch, and four rows reading "bezel_48x48 ↔ housing" look like a bug and
 * make one joint a four-row edit. The patches are still there under the expander,
 * where their area, pair count and position say which corner is which — detection has
 * been wrong before, so this list is how it gets audited, and "show" puts the pink
 * overlay on screen with only the two parts visible. Trusting the list without looking
 * at the overlay is how a phantom joint survives.
 */

import { useState } from 'react';
import {
  PERFECT_CONTACT,
  type Contact,
  type Scenario,
  type Target,
  type ThermalModel,
} from '@/core/types';
import { contactCentroid, createContact, detectContacts } from '@/geometry/contacts';
import { resolveTargetNodes } from '@/physics/assemble';
import { resolvePart, throughThicknessConductance } from '@/physics/materials';
import { Panel } from '../components/Panel';
import { EmptyState, Hint, NumberField } from '../components/fields';
import { groupContactsByPartPair, type ContactGroup } from '../state/contactGroups';
import { formatArea, formatPointMillimetres } from '../state/format';
import { useDispatch, useProject } from '../state/projectStore';
import type { ContactPatch } from '../state/scenarioReducer';
import { partNameOf, selectedPartIds } from '../state/selectors';

/**
 * A delete waiting to be taken back. Re-detection is a separate, whole-model action,
 * so dropping four patches with one click needs a way back that is not "import again".
 */
interface ContactDeletion {
  /** The list the delete produced; the offer stands only while it is still the live one. */
  after: readonly Contact[];
  restore: Contact[];
  what: string;
}

export function ContactsPanel() {
  const { model, scenario, viewer } = useProject();
  const dispatch = useDispatch();
  const contacts = scenario.contacts;
  const groups = groupContactsByPartPair(contacts);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [deletion, setDeletion] = useState<ContactDeletion | null>(null);
  const undoable = deletion && deletion.after === contacts ? deletion : null;
  const selectedIds = selectedPartIds(viewer.selection);
  const canJoin = model !== null && selectedIds.length === 2 && viewer.selection.length >= 2;

  const addFromSelection = () => {
    if (!model) return;
    const [first, second] = splitByPart(viewer.selection);
    if (!first || !second) return;
    try {
      const contact = createContact(
        model,
        resolveTargetNodes(model, first),
        resolveTargetNodes(model, second),
      );
      dispatch({ type: 'contacts/add', contact });
    } catch (error) {
      window.alert(`Could not create a contact: ${(error as Error).message}`);
    }
  };

  const redetect = () => {
    if (!model) return;
    dispatch({ type: 'contacts/replace', contacts: detectContacts(model) });
  };

  const inspect = (partA: string, partB: string) => {
    const allPartIds = (model?.parts ?? []).map((part) => part.id);
    dispatch({ type: 'parts/isolate', partIds: [partA, partB], allPartIds });
    dispatch({ type: 'view/setOverlay', kind: 'contacts', visible: true });
    dispatch({
      type: 'view/setSelection',
      selection: [
        { type: 'part', partId: partA },
        { type: 'part', partId: partB },
      ],
    });
  };

  const toggleExpanded = (key: string) => {
    const next = new Set(expanded);
    if (!next.delete(key)) next.add(key);
    setExpanded(next);
  };

  // Deleting through `replace` rather than `remove` so the whole previous list is the
  // undo, whether one patch went or a joint's worth of them.
  const remove = (ids: readonly string[], what: string) => {
    const doomed = new Set(ids);
    const after = contacts.filter((contact) => !doomed.has(contact.id));
    if (after.length === contacts.length) return;
    dispatch({ type: 'contacts/replace', contacts: after });
    setDeletion({ after, restore: contacts, what });
  };

  return (
    <Panel
      title="Contacts"
      badge={groups.length || undefined}
      actions={
        <button
          type="button"
          onClick={redetect}
          disabled={!model}
          title="Run proximity detection again"
        >
          re-detect
        </button>
      }
    >
      <div className="row">
        <button type="button" disabled={!canJoin} onClick={addFromSelection}>
          + join selection
        </button>
        <button
          type="button"
          className={viewer.overlays.contacts ? 'on' : undefined}
          onClick={() =>
            dispatch({
              type: 'view/setOverlay',
              kind: 'contacts',
              visible: !viewer.overlays.contacts,
            })
          }
        >
          overlay
        </button>
      </div>
      <Hint>
        {canJoin
          ? 'Joins the two selected targets, however far apart they are.'
          : 'Select two faces or parts on different bodies to add a contact by hand.'}
      </Hint>

      {undoable ? (
        <div className="row spread undo-bar">
          <span className="muted">deleted {undoable.what}</span>
          <button
            type="button"
            className="mini"
            onClick={() => dispatch({ type: 'contacts/replace', contacts: undoable.restore })}
          >
            undo
          </button>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <EmptyState>No contacts. Parts exchange no heat without one.</EmptyState>
      ) : (
        <ul className="entity-list expandable">
          {groups.map((group) => (
            <JointRow
              key={group.key}
              group={group}
              label={`${partNameOf(model, group.partA)} ↔ ${partNameOf(model, group.partB)}`}
              expanded={expanded.has(group.key)}
              onToggleExpanded={() => toggleExpanded(group.key)}
              onInspect={() => inspect(group.partA, group.partB)}
              onDelete={remove}
              layer={resistingLayer(model, scenario.partOverrides, group)}
              centroidOf={(contact) =>
                model ? formatPointMillimetres(contactCentroid(model, contact)) : ''
              }
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * The part across this joint whose own thickness resists most, if either does enough
 * to be worth offering.
 *
 * A joint between two metals is a real contact resistance and nothing here applies. A
 * joint onto a slab of wool is not: what the user wants in the box is the wool's own
 * k/t, because the shell solver puts no gradient through a part and the layer's
 * resistance has nowhere else to live. The smaller k/t is the limiting layer, and the
 * cut-off keeps the button off metal-to-metal joints, where it would be noise.
 */
const RESISTING_LAYER_LIMIT = 1e3;

interface ResistingLayer {
  partName: string;
  material: string;
  thickness: number;
  conductance: number;
}

function resistingLayer(
  model: ThermalModel | null,
  overrides: Scenario['partOverrides'],
  group: ContactGroup,
): ResistingLayer | null {
  if (!model) return null;
  let best: ResistingLayer | null = null;
  for (const partId of [group.partA, group.partB]) {
    const part = model.parts.find((candidate) => candidate.id === partId);
    if (!part) continue;
    const conductance = throughThicknessConductance(part, overrides[partId]);
    if (!(conductance > 0) || conductance > RESISTING_LAYER_LIMIT) continue;
    if (best && best.conductance <= conductance) continue;
    const resolved = resolvePart(part, overrides[partId]);
    best = {
      partName: part.name,
      material: resolved.material.name,
      thickness: resolved.thickness,
      conductance,
    };
  }
  return best;
}

interface JointRowProps {
  group: ContactGroup;
  layer: ResistingLayer | null;
  label: string;
  expanded: boolean;
  onToggleExpanded(): void;
  onInspect(): void;
  onDelete(ids: readonly string[], what: string): void;
  centroidOf(contact: Contact): string;
}

function JointRow({
  group,
  layer,
  label,
  expanded,
  onToggleExpanded,
  onInspect,
  onDelete,
  centroidOf,
}: JointRowProps) {
  const dispatch = useDispatch();
  const points = group.patches.length;
  const partlyEnabled = group.enabledCount > 0 && group.enabledCount < points;

  const patchEvery = (patch: ContactPatch) =>
    dispatch({ type: 'contacts/patchMany', ids: group.ids, patch });

  return (
    <li className="entity">
      <div className="entity-head">
        <input
          type="checkbox"
          checked={group.enabledCount > 0}
          ref={(input) => {
            if (input) input.indeterminate = partlyEnabled;
          }}
          title={partlyEnabled ? 'some touch points are off' : 'enabled'}
          onChange={(event) => patchEvery({ enabled: event.target.checked })}
        />
        <button
          type="button"
          className="entity-name"
          title="isolate these two parts and show the contact overlay"
          onClick={onInspect}
        >
          {label}
        </button>
        <button
          type="button"
          className="mini expander"
          aria-expanded={expanded}
          title={expanded ? 'hide the touch points' : 'show the touch points one by one'}
          onClick={onToggleExpanded}
        >
          <span className={`chevron${expanded ? ' open' : ''}`} aria-hidden="true" />
          {points}
        </button>
        <button
          type="button"
          className="mini"
          title={points > 1 ? `delete all ${points} touch points` : 'delete'}
          onClick={() =>
            onDelete(group.ids, points > 1 ? `${label} (${points} touch points)` : label)
          }
        >
          ✕
        </button>
      </div>
      <div className="entity-body">
        <NumberField
          label="conductance"
          suffix="W/m²·K"
          min={0}
          value={group.conductance ?? NaN}
          placeholder="mixed"
          title={
            group.conductance === null
              ? 'The touch points differ; entering a value sets all of them'
              : `Applies to all ${points} touch points of this joint`
          }
          onCommit={(conductance) => patchEvery({ conductance })}
        />
        <div className="row spread">
          <button
            type="button"
            className={group.perfect ? 'on' : undefined}
            title="Welded or bonded: no resistance across the joint"
            onClick={() => patchEvery({ conductance: PERFECT_CONTACT })}
          >
            perfect
          </button>
          {layer ? (
            <button
              type="button"
              title={
                `Carry ${layer.partName}'s own resistance here instead: k / t =` +
                ` ${layer.material} / ${(layer.thickness * 1000).toFixed(1)} mm =` +
                ` ${layer.conductance.toPrecision(3)} W/m²·K. The shell solver puts no gradient` +
                ' through a part, so a layer that insulates has to resist in the joint.'
              }
              onClick={() => patchEvery({ conductance: layer.conductance })}
            >
              k/t = {layer.conductance.toPrecision(3)}
            </button>
          ) : null}
          <span className="muted">
            {points} touch point{points === 1 ? '' : 's'} · {formatArea(group.area)} ·{' '}
            {group.autoDetected ? 'auto' : 'manual'}
          </span>
        </div>
        {group.singlePairPatches > 0 ? (
          <span
            className="flag"
            title={
              'A single vertex stands in for the whole patch, which happens where a fine part' +
              ' lands on a coarse lump. The area is real, but all of it flows through one' +
              ' node-to-node link, so refine the mesh before trusting the joint precisely.'
            }
          >
            ⚠ {group.singlePairPatches} of {points} rest on one node pair ·{' '}
            {formatArea(group.singlePairArea)}
          </span>
        ) : null}
      </div>

      {expanded ? (
        <ul className="entity-sublist">
          {group.patches.map((patch) => (
            <li key={patch.contact.id} className="subentity">
              <div className="entity-head">
                <input
                  type="checkbox"
                  checked={patch.contact.enabled}
                  title="enabled"
                  onChange={(event) =>
                    dispatch({
                      type: 'contacts/patch',
                      id: patch.contact.id,
                      patch: { enabled: event.target.checked },
                    })
                  }
                />
                <span className="point-name">
                  point {patch.index}
                  {patch.singlePair ? <span className="flag"> ⚠</span> : null}
                </span>
                <span className="muted">
                  {patch.pairCount} pair{patch.pairCount === 1 ? '' : 's'} ·{' '}
                  {formatArea(patch.area)}
                </span>
                <button
                  type="button"
                  className="mini"
                  title="delete this touch point"
                  onClick={() => onDelete([patch.contact.id], `${label} point ${patch.index}`)}
                >
                  ✕
                </button>
              </div>
              <span className="muted">at {centroidOf(patch.contact)}</span>
              <NumberField
                label="conductance"
                suffix="W/m²·K"
                min={0}
                value={patch.contact.conductance}
                onCommit={(conductance) =>
                  dispatch({
                    type: 'contacts/patch',
                    id: patch.contact.id,
                    patch: { conductance },
                  })
                }
              />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The first two selected targets that sit on different parts. */
function splitByPart(selection: readonly Target[]): [Target | null, Target | null] {
  const first = selection[0] ?? null;
  if (!first) return [null, null];
  const second = selection.find((target) => target.partId !== first.partId) ?? null;
  return [first, second];
}
