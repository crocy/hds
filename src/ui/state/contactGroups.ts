/**
 * Contacts gathered by the pair of parts they join.
 *
 * Detection emits one patch per place two parts actually touch, so a bezel bolted at
 * four corners is four contacts — four disjoint sets of node pairs, metres apart, all
 * of which the solver and the overlay need. Listing them raw reads as a duplicate bug
 * and makes "change the bezel-to-housing joint" a four-row edit.
 *
 * Grouping therefore happens here, for display only: `Scenario.contacts` stays the
 * flat list, and a group is just a view over the patches plus the aggregates the panel
 * shows. Nothing in this module is persisted or handed to the physics.
 */

import { PERFECT_CONTACT, type Contact } from '@/core/types';
import { contactArea } from '@/geometry/contacts';

export interface ContactPatchRow {
  contact: Contact;
  /** Position within its group, 1-based — what the panel calls "point n". */
  index: number;
  pairCount: number;
  /** m² */
  area: number;
  /**
   * The whole patch hangs off one node-to-node link. Legitimate where a fine part
   * lands on a coarse lump — a whole mating face can reduce to one vertex — but the
   * area is then extrapolated from that single vertex, so the joint is worth a look
   * before its answer is trusted.
   */
  singlePair: boolean;
}

export interface ContactGroup {
  /** Stable, and independent of which side detection happened to call A. */
  key: string;
  partA: string;
  partB: string;
  patches: ContactPatchRow[];
  /** Every patch id, for the bulk edit and delete actions. */
  ids: string[];
  pairCount: number;
  /** m² */
  area: number;
  /** W/(m²·K), or null when the patches disagree. */
  conductance: number | null;
  enabledCount: number;
  /** Every patch is bonded. */
  perfect: boolean;
  /** Every patch came from proximity detection rather than being added by hand. */
  autoDetected: boolean;
  singlePairPatches: number;
  /** m² carried by those single-pair patches. */
  singlePairArea: number;
}

/**
 * One group per pair of parts, in the order the pairings first appear, with each
 * group's patches in scenario order. Part order within a pairing is canonicalised, so
 * a hand-made B→A contact lands in the same group as a detected A→B one.
 */
export function groupContactsByPartPair(contacts: readonly Contact[]): ContactGroup[] {
  const groups: ContactGroup[] = [];
  const byKey = new Map<string, ContactGroup>();

  for (const contact of contacts) {
    const [partA, partB] =
      contact.partA <= contact.partB
        ? [contact.partA, contact.partB]
        : [contact.partB, contact.partA];
    const key = `${partA} ${partB}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        partA,
        partB,
        patches: [],
        ids: [],
        pairCount: 0,
        area: 0,
        conductance: contact.conductance,
        enabledCount: 0,
        perfect: true,
        autoDetected: true,
        singlePairPatches: 0,
        singlePairArea: 0,
      };
      byKey.set(key, group);
      groups.push(group);
    }

    const pairCount = contact.nodePairs.length / 2;
    const area = contactArea(contact);
    group.patches.push({
      contact,
      index: group.patches.length + 1,
      pairCount,
      area,
      singlePair: pairCount === 1,
    });
    group.ids.push(contact.id);
    group.pairCount += pairCount;
    group.area += area;
    if (group.conductance !== contact.conductance) group.conductance = null;
    if (contact.enabled) group.enabledCount++;
    if (contact.conductance < PERFECT_CONTACT) group.perfect = false;
    if (!contact.autoDetected) group.autoDetected = false;
    if (pairCount === 1) {
      group.singlePairPatches++;
      group.singlePairArea += area;
    }
  }

  return groups;
}
