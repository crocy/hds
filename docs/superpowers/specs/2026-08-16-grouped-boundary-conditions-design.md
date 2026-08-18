# Grouped boundary conditions

**Status:** approved, 2026-08-16

A boundary condition applies to a *set* of targets rather than a single one, so several
parts, faces, edges or points picked in the viewer become one row in the panel carrying
one temperature, one heat load or one film coefficient.

## 1. Why

Today the panel loops over the selection and creates one condition per target
(`BoundaryConditionsPanel.addFromSelection`). Putting 200 °C on six faces of a housing
produces six rows that must be edited six times and read as duplicates. The user wants
to click the six faces, click `+ fixed temp`, and get one row.

The rejected alternative was a `groupId` beside the existing single `target`, grouping
at display time the way `ui/state/contactGroups.ts` does for contact patches. Display-only
grouping works there because the grouping is *derivable* (same pair of parts) and carries
no physics. Here the grouping is a user's authoring intent and it changes what a heat
load means, so it belongs in the data model.

## 2. Data model

`core/types.ts`:

```ts
export type BoundaryCondition =
  | { id: string; kind: 'fixedTemp'; targets: Target[]; value: number; enabled: boolean }
  | { id: string; kind: 'heatLoad'; targets: Target[]; watts: number; enabled: boolean }
  | { id: string; kind: 'convection'; targets: Target[]; h: number | 'auto'; enabled: boolean };
```

Invariants, enforced on every write path (`entityFactories`, `scenarioReducer`):

- `targets` is non-empty. A condition naming nothing is meaningless; the row's own delete
  button is how you get rid of one.
- `targets` is deduplicated by `targetKey`. Clicking the same face twice toggles it out
  rather than staging it twice, but the reducer does not trust that.

Targets within a set may mix granularities. The union of nodes is well defined for any
mixture, so `face + edge` is a legal boundary and the panel just labels it as such.

## 3. Interaction

`ViewerState` gains two fields beside `selection`:

```ts
bcDraft: Target[];      // the group being staged, not yet a condition
bcCollecting: boolean;  // whether viewer clicks route to bcDraft
```

Click routing in `ThermalScene.onPointerUp`:

```
click in viewer
   │
   ├─ bcCollecting = false ──► picker.select(target, shiftKey)     unchanged
   │                            plain click replaces, shift toggles
   │
   └─ bcCollecting = true  ──► applySelection(bcDraft, target, /* additive */ true)
                                already staged → dropped
                                otherwise      → appended
                                the global selection is not touched
```

The draft draws in its own highlight layer in amber (`DRAFT_COLOR`), distinct from the
blue selection, so "what I am building" and "what is selected" are never confused.

Staging deliberately does not disturb the global selection, because other panels read it:
the part tree edits whatever is selected and `ContactsPanel` joins the first two distinct
parts in it. Collecting six faces for a heat load must not hijack either.

`Escape` clears the draft when it is non-empty, and the selection otherwise.

A click that misses the model leaves the staged group alone — the opposite of the
non-collecting case, where it clears the selection. Staging is a series of deliberate
toggles, and losing six clicked faces to one stray click on the background is not a trade
worth making.

### Creating a condition

The `+ fixed temp` / `+ heat load` / `+ convection` buttons build **one** condition from
the draft when it is non-empty, and from the global selection when it is not. The fallback
keeps today's flow intact — click a part in the tree, press `+ fixed temp` — while making
it produce a single grouped row instead of one row per selected target.

After creation the draft empties and `bcCollecting` stays armed, so the next group can be
built straight away.

## 4. Physics

Two helpers in `physics/assemble.ts`, both deduplicating and stable in order:

```ts
export function unionTargetNodes(model: ThermalModel, targets: readonly Target[]): Uint32Array
export function unionTargetTriangles(model: ThermalModel, targets: readonly Target[]): Uint32Array
```

- **fixedTemp** pins every node of the union. Solving a group is identical to solving the
  same targets as separate conditions; grouping is authoring convenience only.
- **convection** applies `h` to every triangle of the union, via `convectionOverrides`.
- **heatLoad** treats `watts` as the total over the whole group, area-weighted across the
  union: `share = nodeArea[node] / totalArea`. The number in the box is the number of
  watts entering the assembly, which is the invariant the heat balance reports back, and
  it holds however members are added or removed.

Because the node set is a *union*, a group holding a part and one of that part's faces
injects each node once. Two overlapping conditions authored separately double-inject
today; grouping removes that for anything expressed as one group.

Nothing else in the solver changes. The per-DOF conflicting-fixed-temperature warning
still fires, now naming the group's id.

## 5. Panel

One row per condition. The head labels the group by composition:

- one target → exactly today's `describeTarget` text;
- several sharing a part → `housing · 4 faces`;
- spanning parts → `4 faces on 3 parts`;
- mixed granularity → `3 faces + 1 edge`.

Clicking the head selects every member. The expanded body keeps the existing value field
and adds the member list:

```
housing · 4 faces                    5 W · 812 nodes
  face 12    210 nodes   1.9 W  ✕
  face 13    198 nodes   1.7 W  ✕
  face 27    404 nodes   1.4 W  ✕
  face 31      0 nodes     —    ✕     covered by an earlier member
  [ add staged (3) ]
```

Each node is attributed to the **first** member that claims it, so an overlapping member
shows zero nodes and reads as covered rather than silently double-counting. The watts
column appears for `heatLoad` only and sums to the typed total. `add staged` folds the
current draft into this condition. The last member's `✕` is disabled — deleting the
condition is the row's own `✕`.

The arithmetic lives in a React-free `ui/state/conditionTargets.ts`, unit-tested in Node,
in the same spirit as `contactGroups.ts`. The row moves to its own component file so the
panel does not grow past what fits in one screen.

**Agreeing with the DOF map.** Resolving a member's nodes with the solver's own
`resolveTargetNodes` is not by itself enough to make the panel and the solve agree: the
solve then drops every node that gets no DOF, and `buildDofMap` gives none at all to a part
typed `insulator`. That is the only body type it skips — a lump collapses its nodes onto one
DOF and a sheet pairs its two skins, but in both cases every node still has one, so their
areas already add up as the panel shows them.

A member on an insulating part therefore contributes nothing here either: zero nodes, zero
area, none of the watts, and a note saying the solve leaves that part out. Without it a
group holding an insulator would read as though that member carried its area share while
the solve quietly spread those watts over the others.

## 6. Persistence

`PROJECT_VERSION` goes to 2. `parseProjectFile` currently rejects any version it did not
write; it learns to accept 1 as well. The upgrade itself — each condition's `{ target }`
into `{ targets: [target] }` — runs in `openProject` rather than in `parseProjectFile`,
because `parseProjectFile` returns a bare `ProjectFile` and has no channel for a
`ProjectIssue`: putting the upgrade there would mean dropping a malformed condition
silently. It runs before `resolveScenarioAgainstModel`, so a version 1 file naming a face
that no longer exists reports the usual issue instead of crashing on an absent `targets`.

A version 1 condition whose `target` is absent or malformed is dropped with an issue. It
cannot become `{ targets: [] }`: the non-empty invariant of §2 has no room for it, and
silently keeping a condition that names nothing is worse than saying it went.

`bcDraft` and `bcCollecting` are **not** persisted. A staged-but-uncommitted group is not
scenario state, and a project describes what was committed. `createProjectFile` writes them
empty rather than omitting the keys — `ProjectFile.viewer` is typed `ViewerState`, so
omitting would make the fields optional there and push "may be absent" onto every reader of
the format. `normaliseViewerState` already spreads `DEFAULT_VIEWER_STATE` first, so files
written by either version load with an empty draft either way.

`resolveScenarioAgainstModel` re-resolves per member: dead members are dropped and reported
as a `ProjectIssue` naming them, and the condition survives on whatever is left. Only a
condition whose members are *all* unresolvable is dropped, which is today's behaviour for
the single-target case.

## 7. Cleanup carried by this change

`ui/state/projectReducer.ts` carries a hand-copied `targetKey` with the comment "Local copy
of the viewer's `targetKey`, so this module stays free of three.js", and the reducer needs
the same function again to deduplicate a target set. The pure target helpers —
`targetKey`, `targetsEqual`, `applySelection` — therefore move to a new `core/targets.ts`,
free of three.js, and the copy is deleted. `viewer/picking.ts` imports them from there,
and `@/viewer` stops re-exporting them.

## 8. Verification

Unit:

- `assemble` — the union deduplicates a part plus its own face; a grouped heat load injects
  exactly the typed watts and splits them by area; a grouped fixed temperature pins every
  member's nodes.
- `conditionTargets` — labels by composition; first-claim attribution zeroes an overlapped
  member; per-member watts sum to the total.
- `scenarioReducer` — `bc/setTargets` deduplicates, refuses an empty set, and returns the
  same state object when nothing changed (the identity rule the overlay layer leans on).
- `project` — a version 1 file opens with one-member groups; a group with one dead member
  survives and reports an issue; a group with every member dead is dropped; a saved file
  carries no draft.

Integration, on the TBTE model: a fixed temperature over faces A and B as one group solves
to the same field as two separate conditions on A and B. That pins "grouping is authoring
convenience" as a property rather than a claim.

Manual: load the STEP, arm collect, click three faces, confirm one row, solve, confirm the
balance closes and the injected watts equal the typed total.
