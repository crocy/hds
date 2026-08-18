# Session handoff

Last updated: 2026-08-16

Read [README.md](../README.md) for what the tool does and
[docs/superpowers/specs/](../docs/superpowers/specs/) for why it works the way it does.
This file carries only what those two do not: current state, open follow-ups, and the
traps that have already cost time.

## Where we are

The simulator works end to end in a browser: import STEP/STL/OBJ, assign materials and
boundary conditions, solve in a worker, read the field in 3D plus five analysis plots,
save and reload projects. Verified by hand against `ohisje - TBTE 2x116.step` — 7 parts,
10 472 triangles, solve in ~460 ms.

Gates: `pnpm typecheck`, `pnpm lint`, `pnpm test` (435+) and `pnpm build` all pass.

## Open follow-ups

Numbered roughly by value, not by effort.

1. **Cache the through-thickness pairing.** `pairThroughThickness` rebuilds a BVH and
   raycasts every node inside every `buildDofMap` call — about 0.2 s of a 0.73 s solve.
   It depends only on geometry plus resolved thickness and body type, so it belongs on
   `ThermalModel` as a cached `nodeOpposite: Int32Array`, invalidated when either
   override changes.
2. **Path-length analysis is unaware of merged DOFs.** `buildConductionGraph` walks the
   raw node graph, so λ is fit over both skins as separate points carrying identical
   temperatures. Harmless numerically, but it means λ measures something slightly
   different from what the merged model implies — and λ is already an open question
   (see the README's verification caveats).
3. **Three types are defined in two places.** `PlaneExtent` exists in both
   `analysis/slice2d` and `viewer/sectionGizmo`; `ViewerState` lives in `ui/state` but
   the design wants it in `core`; `section.ts` had to extend `SectionPolyline` as
   `SectionPolylineDetail` because the base type lacks `partIndex`/`cavityId`.
4. **`Scenario` cannot carry custom materials.** `PartOverride` holds only an id and
   `resolvePart` refuses to guess, so the UI keeps a runtime registry and the solve
   worker re-registers copies travelling with each request. `Scenario.customMaterials`
   in core would remove the side channel.
5. **Viewer has no per-layer overlay refresh.** `assignFaceRegionCavity` mutates
   `triCavity` in place, and only `setModel` re-marks the cavity layer stale, so the app
   bumps a `modelRevision` and re-runs `setModel` restoring the camera by hand. A
   `ThermalScene.invalidateOverlay(kind)` would remove that dance.
6. **Smaller:** convection boundary conditions solve but have no overlay; contact
   re-detection runs on the main thread (~0.5 s, explicit user action);
   `geometry/build` still assigns default material ids, which belongs with the material
   library.

## Traps that have already cost time

- **Never `git add -A` while agents are running.** It has twice swept an agent's
  throwaway demo files into a commit, and once captured a mid-flight snapshot of a
  module. Stage explicit paths.
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
