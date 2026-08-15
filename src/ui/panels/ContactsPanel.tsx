/**
 * Contacts — the only path heat has between parts, since nodes are never welded
 * across them.
 *
 * Detection has been wrong before, so every row shows what it is built from (pair
 * count and area) and "show" puts the pink contact overlay on screen with only the
 * two parts visible. Trusting the list without looking at the overlay is how a
 * phantom joint survives.
 */

import { PERFECT_CONTACT, type Target } from '@/core/types';
import { contactArea, createContact, detectContacts } from '@/geometry/contacts';
import { resolveTargetNodes } from '@/physics/assemble';
import { Panel } from '../components/Panel';
import { EmptyState, Hint, NumberField } from '../components/fields';
import { formatArea } from '../state/format';
import { useDispatch, useProject } from '../state/projectStore';
import { partNameOf, selectedPartIds } from '../state/selectors';

export function ContactsPanel() {
  const { model, scenario, viewer } = useProject();
  const dispatch = useDispatch();
  const contacts = scenario.contacts;
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

  return (
    <Panel
      title="Contacts"
      badge={contacts.length || undefined}
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

      {contacts.length === 0 ? (
        <EmptyState>No contacts. Parts exchange no heat without one.</EmptyState>
      ) : (
        <ul className="entity-list">
          {contacts.map((contact) => (
            <li key={contact.id} className="entity">
              <div className="entity-head">
                <input
                  type="checkbox"
                  checked={contact.enabled}
                  title="enabled"
                  onChange={(event) =>
                    dispatch({
                      type: 'contacts/patch',
                      id: contact.id,
                      patch: { enabled: event.target.checked },
                    })
                  }
                />
                <button
                  type="button"
                  className="entity-name"
                  title="isolate these two parts and show the contact overlay"
                  onClick={() => inspect(contact.partA, contact.partB)}
                >
                  {partNameOf(model, contact.partA)} ↔ {partNameOf(model, contact.partB)}
                </button>
                <button
                  type="button"
                  className="mini"
                  title="delete"
                  onClick={() => dispatch({ type: 'contacts/remove', id: contact.id })}
                >
                  ✕
                </button>
              </div>
              <div className="entity-body">
                <NumberField
                  label="conductance"
                  suffix="W/m²·K"
                  min={0}
                  value={contact.conductance}
                  onCommit={(conductance) =>
                    dispatch({ type: 'contacts/patch', id: contact.id, patch: { conductance } })
                  }
                />
                <button
                  type="button"
                  className={contact.conductance >= PERFECT_CONTACT ? 'on' : undefined}
                  title="Welded or bonded: no resistance across the joint"
                  onClick={() =>
                    dispatch({
                      type: 'contacts/patch',
                      id: contact.id,
                      patch: { conductance: PERFECT_CONTACT },
                    })
                  }
                >
                  perfect
                </button>
                <span className="muted">
                  {contact.nodePairs.length / 2} pairs · {formatArea(contactArea(contact))} ·{' '}
                  {contact.autoDetected ? 'auto' : 'manual'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The first two selected targets that sit on different parts. */
function splitByPart(selection: readonly Target[]): [Target | null, Target | null] {
  const first = selection[0] ?? null;
  if (!first) return [null, null];
  const second = selection.find((target) => target.partId !== first.partId) ?? null;
  return [first, second];
}
