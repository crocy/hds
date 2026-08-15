/**
 * Detection splits a joint into one patch per place the parts touch, and on the TBTE
 * housing two pairings come back with four patches each. That has already been read
 * once as detection emitting the same joint repeatedly and doubling its conductance.
 * It is not: the patches are the four corners of a bolted bezel, they share no node
 * pair, and dropping or merging any of them would change the answer.
 *
 * This test pins that down against the real STEP file — patches of a pairing are
 * disjoint, no node pair is claimed twice anywhere in the model, and the panel's
 * grouping is a pure regrouping that neither loses nor double-counts area.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildThermalModel } from '../geometry/build';
import { contactArea, detectContacts } from '../geometry/contacts';
import { createOcctModule, importStep } from '../geometry/importers/step';
import { groupContactsByPartPair } from '../ui/state/contactGroups';
import type { Contact } from '../core/types';

const require = createRequire(import.meta.url);
const WASM_PATH = require.resolve('occt-import-js/dist/occt-import-js.wasm');
const STEP_PATH = fileURLToPath(new URL('../../ohisje - TBTE 2x116.step', import.meta.url));

/** Node pairs as unordered "low:high" keys, so an A→B and a B→A link collide. */
function nodePairKeys(contact: Contact): string[] {
  const keys: string[] = [];
  for (let i = 0; i < contact.nodePairs.length; i += 2) {
    const a = contact.nodePairs[i];
    const b = contact.nodePairs[i + 1];
    keys.push(a < b ? `${a}:${b}` : `${b}:${a}`);
  }
  return keys;
}

describe('TBTE contact patches', () => {
  it('are disjoint, unduplicated, and group without changing the total area', async () => {
    const occt = await createOcctModule({
      locateFile: (file) => (file.endsWith('.wasm') ? WASM_PATH : file),
    });
    const model = buildThermalModel(await importStep(readFileSync(STEP_PATH), { occt }));
    const contacts = detectContacts(model);
    const groups = groupContactsByPartPair(contacts);

    // Measured ground truth: 14 patches over 8 part pairings. A change here is a
    // change in detection, not in this test's subject.
    expect(contacts.length).toBe(14);
    expect(groups.length).toBe(8);

    // No node-to-node link may appear twice: two contacts carrying the same pair
    // would put two conductances in parallel across one joint.
    const owner = new Map<string, string>();
    for (const contact of contacts) {
      for (const key of nodePairKeys(contact)) {
        expect(owner.get(key)).toBeUndefined();
        owner.set(key, contact.id);
      }
    }
    expect(owner.size).toBe(contacts.reduce((total, c) => total + c.nodePairs.length / 2, 0));

    // ...and in particular the repeated pairings are separate places the parts touch.
    for (const group of groups) {
      const seen = new Set<string>();
      for (const patch of group.patches) {
        for (const key of nodePairKeys(patch.contact)) {
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
      expect(seen.size).toBe(group.pairCount);
    }

    // Grouping is a view: every patch lands in exactly one group, and the areas add up.
    expect(groups.flatMap((group) => group.ids).sort()).toEqual(
      contacts.map((contact) => contact.id).sort(),
    );
    const detectedArea = contacts.reduce((total, contact) => total + contactArea(contact), 0);
    const groupedArea = groups.reduce((total, group) => total + group.area, 0);
    expect(groupedArea).toBeCloseTo(detectedArea, 12);

    // The bezel is bolted at four corners, each landing on a single vertex of the
    // coarse housing lump: four one-pair patches, ~18.2 cm² between them, spread over
    // the 48 mm bezel. This is the case that must stay visible in the panel — real
    // area resting on one node-to-node link each.
    const bezelName = model.parts.find((part) => part.name === 'bezel_48x48')?.id;
    const housingName = model.parts.find((part) => part.name === 'housing')?.id;
    const bezelToHousing = groups.find(
      (group) =>
        (group.partA === bezelName && group.partB === housingName) ||
        (group.partA === housingName && group.partB === bezelName),
    );
    expect(bezelToHousing).toBeDefined();
    expect(bezelToHousing!.patches.length).toBe(4);
    expect(bezelToHousing!.singlePairPatches).toBe(4);
    expect(bezelToHousing!.area * 1e4).toBeCloseTo(18.2, 1);
  }, 300_000);
});
