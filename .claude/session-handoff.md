# Session handoff

Last updated: 2026-08-18

Read [README.md](../README.md) for what the tool does and
[docs/superpowers/specs/](../docs/superpowers/specs/) for why it works the way it does.
This file carries only what those two do not: current state, open follow-ups, and the
traps that have already cost time.

## Where we are

The simulator works end to end in a browser: import STEP/STL/OBJ, assign materials and
boundary conditions, solve in a worker, read the field in 3D plus five analysis plots,
save and reload projects. Verified by hand against `ohisje - TBTE 2x116.step` — 7 parts,
10 472 triangles, solve in ~460 ms.

Gates: `pnpm typecheck`, `pnpm lint` and `pnpm test` (609) all pass, and `pnpm build`.

Published at **https://crocy.github.io/hds/**, deployed by
`.github/workflows/deploy.yml` on every push to `main`. The deploy is gated on the
full suite, so a broken commit cannot reach the public URL.

## What changed on 2026-08-18

Driven by a user assembly (`sestava` / `ohisje - OK`) that solved to **zero watts** — a
200 °C block with no metal-to-metal joint anywhere.

- **31f4890** — cavities are now merged by line of sight, not shared mesh edge alone.
  Parts separated by a gap share no edge, so every pocket was walled by a single part,
  and a pocket walled by one part equilibrates with it and carries nothing. This was
  true of the TBTE reference too: all seven of its cavities were one-part, its header
  claimed a pocket path that did not exist, and its watts went through the bolted
  joints. TBTE now reads 93.3 W against 82.5 W.
- **e159813** — the balance no longer bills a contact onto an `insulator` part. The
  assembly always skipped those links; the balance read contacts off the scenario and
  charged the joint for the full drop onto a part merely *reported* at ambient — 2.3e7 W
  on a real model, condemning an otherwise sound field. Such a joint now warns.
- **e886716** — new `solid` body type: the part is filled with cells and conducted in
  3D. A thick low-k body conducted as a sheet short-circuits its own thickness along its
  skin, which is fatal for insulation (Bi ≈ 9 for 40 mm of glass wool against ≈5e-4 for
  1 mm steel). Verified against the analytic slab at three grid resolutions.
- **bb847b2** — clicking a cavity row shows that pocket's walls alone.
- **980c335** — a joint offers the `k/t` of the low-k part across it.

Nothing pushed.

## Open follow-ups

Numbered roughly by value, not by effort.

1. **A cavity wall cannot say "I am touching something".** Detection asks only "can this
   face see the sky?", so a surface pressed against another part is still a cavity wall
   and still convects and radiates to the pocket air — on top of conducting through its
   contact. Measured on the user's housing: **72 % of a 9363 cm² pocket wall was within
   0.5 mm of another part**, so whatever `h` and `ε` the user picks are applied to 3.5×
   the area that faces a real void. The only workaround today is to scale `h` and `ε` by
   the void fraction by hand. A third per-triangle state — enclosed, open, or in contact
   — would fix it properly.
2. **Cache the through-thickness pairing.** `pairThroughThickness` rebuilds a BVH and
   raycasts every node inside every `buildDofMap` call — about 0.2 s of a 0.73 s solve.
   It depends only on geometry plus resolved thickness and body type, so it belongs on
   `ThermalModel` as a cached `nodeOpposite: Int32Array`, invalidated when either
   override changes.
3. **Path-length analysis is unaware of merged DOFs.** `buildConductionGraph` walks the
   raw node graph, so λ is fit over both skins as separate points carrying identical
   temperatures. Harmless numerically, but it means λ measures something slightly
   different from what the merged model implies — and λ is already an open question
   (see the README's verification caveats).
4. **Three types are defined in two places.** `PlaneExtent` exists in both
   `analysis/slice2d` and `viewer/sectionGizmo`; `ViewerState` lives in `ui/state` but
   the design wants it in `core`; `section.ts` had to extend `SectionPolyline` as
   `SectionPolylineDetail` because the base type lacks `partIndex`/`cavityId`.
5. **`Scenario` cannot carry custom materials.** `PartOverride` holds only an id and
   `resolvePart` refuses to guess, so the UI keeps a runtime registry and the solve
   worker re-registers copies travelling with each request. `Scenario.customMaterials`
   in core would remove the side channel.
6. **Viewer has no per-layer overlay refresh.** `assignFaceRegionCavity` mutates
   `triCavity` in place, and only `setModel` re-marks the cavity layer stale, so the app
   bumps a `modelRevision` and re-runs `setModel` restoring the camera by hand. A
   `ThermalScene.invalidateOverlay(kind)` would remove that dance.
7. **`solid` parts are limited by the surface mesh, not the grid.** A flat-faced box
   tessellates to the minimum triangle count and no deflection setting refines it, so a
   40 mm wool block arrives as 28 triangles / 16 nodes. Two of those nodes landed in
   *both* of its contacts, which is a zero-resistance bridge from the block to the
   housing straight past the insulation — worth ~2 W there, but it puts a fake 200 °C
   spot on the housing. Consider warning when one node carries two contacts to different
   parts.
8. **Re-import silently drops manual contacts.** Contact re-detection rebuilds the list
   by proximity, so a hand-added joint across a gap wider than the 0.5 mm tolerance
   disappears. It cost a session's confusion: a part went thermally afloat and only the
   `adiabatic` case exposed it, because the cavity air had been quietly feeding it.
9. **Smaller:** convection boundary conditions solve but have no overlay; contact
   re-detection runs on the main thread (~0.5 s, explicit user action);
   `geometry/build` still assigns default material ids, which belongs with the material
   library.

## Traps that have already cost time

- **The site is served from a subpath, so absolute asset URLs break.** `vite.config.ts`
  sets `base: '/hds/'`, and anything reaching into `public/` must go through
  `import.meta.env.BASE_URL` rather than a leading `/`. This already bit once: the OCCT
  wasm was fetched from `/occt-import-js.wasm`, which under Pages returns the SPA's
  `index.html`, and the loader died on `expected magic word 00 61 73 6d, found 3c 21 64
  6f` — the bytes of `<!do`. STL and OBJ kept working, so only STEP broke, only in
  production, and no test noticed. `base` is deliberately a constant rather than
  build-only so dev runs on the same subpath and the next one cannot hide until deploy.

- **Never `git add -A` while agents are running.** It has twice swept an agent's
  throwaway demo files into a commit, and once captured a mid-flight snapshot of a
  module. Stage explicit paths.
- **Cite SHAs that are on `main`, not the ones you just made.** Work here happens in
  worktrees and lands rebased, so the commit you wrote is not the commit that ships. The
  2026-08-18 entries below originally cited five SHAs that existed but were not ancestors
  of `main`; they would have been garbage-collected with the worktree branch, rotting
  every reference. Before writing a SHA into this file, check it:
  `git merge-base --is-ancestor <sha> main`.

- **`.claude/worktrees/` holds other sessions' checkouts.** Each has its own
  `tsconfig.json`, which made `typescript-eslint` refuse to pick a `tsconfigRootDir`
  and produced 364 parse errors. `eslint.config.js` now ignores `.claude` — leave that
  ignore in place.
- **Use corepack 0.34.7 exactly — not `@latest`.** The repo pins `pnpm@11.22.0` in
  `packageManager`, which `pnpm/setup` reads in CI. Locally that needs a user-level
  corepack, because Ubuntu's packaged one (0.24.0, at `/usr/share/nodejs/corepack`)
  cannot load pnpm 11 and dies with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`:

  ```bash
  npm install -g corepack@0.34.7
  corepack enable --install-directory ~/.local/bin pnpm
  ```

  It has to be 0.34.7 rather than the newest. corepack 0.35.0 raised its Node floor to
  `^22.22.2`, and Ubuntu 26.04 ships 22.22.1 from `universe` with no newer candidate —
  one patch short, with nothing in APT to close it. 0.34.7 accepts `^22.11.0`, runs
  pnpm 11.22.0, and emits no engine warning. So `npm i -g corepack@latest` silently
  undoes this; if it happens, the symptom is an `EBADENGINE` warning on every install,
  not a failure.

  Node itself is fine and does not need replacing. Reach for a user-level version
  manager (fnm, nvm, mise) only if something genuinely requires a newer Node —
  NodeSource's APT repo replaces Ubuntu's `nodejs` package and fights its `node-*` debs.

- **Switching a checkout between pnpm 10 and 11** makes pnpm want to purge
  `node_modules`, which aborts without a TTY. Delete the directory and reinstall.
- **TypeScript is pinned to 6.0.3 deliberately.** TS 7 (the Go port) typechecks fine but
  `typescript-eslint` will not load against it, which costs the react-hooks rules.
- **Tests do not catch visual defects.** Every plot and viewer bug found so far was found
  by looking at the running app, never by the suite: an invisible scatter, an empty cut
  plane, a stretched section field, a colliding annotation, overlapping legends. Run
  `pnpm dev`, load the STEP, and look before calling UI work done.
- **Numbers from the TBTE test are not all comparable to the reference figure.** The
  README's verification section says which are and which are not. Read it before
  quoting one.
- **A closed energy balance does not mean a connected model.** The assembly that started
  the 2026-08-18 session solved to 0 W, converged, and reported a residual of 1e-9 W:
  every part sat at exactly ambient and the balance was satisfied because nothing moved.
  Check that the source actually injects watts, and that every part sheds some, before
  reading any field. Per-part `injected` / `convection` / `radiation` in the balance is
  where that shows.
- **A saved project embeds its mesh, so detection fixes do not reach it.** `triCavity`
  and the cavity list travel inside the `.hds.json`; re-import the CAD to pick up a
  change to `detectCavities` or `detectContacts`.
