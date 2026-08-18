/**
 * The application shell: it owns the `ThermalScene`, the two workers, and the
 * effects that push state into the viewer.
 *
 * The rule that keeps this tractable: state flows one way. Panels dispatch, the
 * reducer produces the next `ProjectState`, and the effects below hand the parts the
 * viewer needs to `ThermalScene`. Nothing reads back out of the scene except the few
 * things only it knows — the framed camera, the section plane's offset range, and the
 * resolved colour range the legend has to label.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThermalModel, Vec3 } from '@/core/types';
import { sameTargets } from '@/core/targets';
import { CAVITY_DEFAULTS } from '@/geometry/cavity';
import { planeBasis, sectionModel, type SectionPolylineDetail } from '@/geometry/section';
import { solveSliceField } from '@/analysis/slice2d';
import { formatFromFilename, type ImportFormat } from '@/geometry/importers';
import { hashBytes } from '@/io/hash';
import { ImportRunner } from '@/io/importClient';
import type { ImportSettings } from '@/io/importPipeline';
import {
  downloadText,
  isProjectFilename,
  readFileBytes,
  readFileText,
  suggestProjectFilename,
} from '@/io/file';
import {
  openProject,
  parseProjectFile,
  serialiseProject,
  type OpenedProject,
  type ProjectSnapshot,
} from '@/io/project';
import {
  axisNormal,
  clampOffset,
  offsetRange,
  planeFromOffset,
  planeOffset,
  resolveScaleRange,
  sectionExtent,
  BACKGROUND_COLORS,
  NO_DATA_COLORS,
  OVERLAY_KINDS,
  SELECTION_MODE_HOTKEYS,
  type ResolvedColorScale,
  type ThermalScene,
  type ThermalSceneHandlers,
} from '@/viewer';
import { HoverReadout } from '@/ui/components/HoverReadout';
import { ImportDialog } from '@/ui/components/ImportDialog';
import { Legend } from '@/ui/components/Legend';
import { StatusOverlay } from '@/ui/components/StatusOverlay';
import { Toolbar } from '@/ui/components/Toolbar';
import { BoundaryConditionsPanel } from '@/ui/panels/BoundaryConditionsPanel';
import { CavitiesPanel } from '@/ui/panels/CavitiesPanel';
import { ColorScalePanel } from '@/ui/panels/ColorScalePanel';
import { ContactsPanel } from '@/ui/panels/ContactsPanel';
import { DisplayPanel } from '@/ui/panels/DisplayPanel';
import { EnvironmentPanel } from '@/ui/panels/EnvironmentPanel';
import { MaterialsPanel } from '@/ui/panels/MaterialsPanel';
import { PartTreePanel } from '@/ui/panels/PartTreePanel';
import { PlotsDock, type SectionSlice } from '@/ui/panels/PlotsDock';
import { ResultsPanel } from '@/ui/panels/ResultsPanel';
import { SectionPanel } from '@/ui/panels/SectionPanel';
import { createHoverStore } from '@/ui/state/hoverStore';
import { missingLibraryIds, registerCustomLibrary } from '@/ui/state/materialLibrary';
import { ProjectProvider, useDispatch, useProject } from '@/ui/state/projectStore';
import { SolveRunner, SUPERSEDED_SOLVE } from '@/ui/state/solveClient';
import { useThermalScene } from '@/ui/state/useThermalScene';
import { ThemeProvider, useTheme } from '@/ui/theme';
import type { ProjectState } from '@/ui/state/projectReducer';
import type { ViewerState } from '@/ui/state/viewerState';

export function App() {
  return (
    <ThemeProvider>
      <ProjectProvider>
        <Workspace />
      </ProjectProvider>
    </ThemeProvider>
  );
}

/** Debounce on the 2D slice solve: a gizmo drag would otherwise queue one per frame. */
const SLICE_DEBOUNCE_MS = 140;

function Workspace() {
  const state = useProject();
  const dispatch = useDispatch();
  const { resolved } = useTheme();
  const { model, modelRevision, scenario, viewer, solve, source, importSettings } = state;
  const section = viewer.section;

  const [hoverStore] = useState(createHoverStore);
  const [slice, setSlice] = useState<SectionSlice | null>(null);
  const [sliceStatus, setSliceStatus] = useState('Section is off.');
  const [pendingImport, setPendingImport] = useState<{ file: File; format: ImportFormat } | null>(
    null,
  );
  const [embedMesh, setEmbedMesh] = useState(true);
  const [plotsOpen, setPlotsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);

  const cadInputRef = useRef<HTMLInputElement | null>(null);
  const projectInputRef = useRef<HTMLInputElement | null>(null);
  const solveRunnerRef = useRef<SolveRunner | null>(null);
  const importRunnerRef = useRef<ImportRunner | null>(null);

  // Read by effects that must not re-run when these change.
  const stateRef = useLatest(state);
  const temperature = solve.result?.temperature ?? null;
  const temperatureRef = useLatest(temperature);

  // Derived, not stored: the same maths the viewer would do, so the legend and the
  // slice solve can be computed without asking the scene and feeding its answer back
  // into React state.
  const resolvedScale = useMemo<ResolvedColorScale>(() => {
    const [min, max] = resolveScaleRange(scenario.colorScale, temperature, scenario.ambient);
    return { min, max, map: scenario.colorScale.map };
  }, [scenario.colorScale, scenario.ambient, temperature]);

  const sectionNormal = useMemo(
    () => axisNormal(section.axis, section.sign),
    [section.axis, section.sign],
  );
  const sectionRange = useMemo(
    () => (model ? offsetRange(model.bbox, sectionNormal) : { min: -1, max: 1 }),
    [model, sectionNormal],
  );
  const sectionOffset = model
    ? clampOffset(
        section.offset ?? (sectionRange.min + sectionRange.max) / 2,
        model.bbox,
        sectionNormal,
      )
    : 0;
  const sectionPlane = useMemo(
    () => (model && section.enabled ? planeFromOffset(sectionNormal, sectionOffset) : null),
    [model, section.enabled, sectionNormal, sectionOffset],
  );
  const sectionOffsetRef = useLatest(sectionOffset);

  const handlers = useMemo<ThermalSceneHandlers>(
    () => ({
      onHover: (hover) => hoverStore.set(hover),
      onSelectionChange: (selection) => dispatch({ type: 'view/setSelection', selection }),
      onDraftChange: (targets) => dispatch({ type: 'view/setBcDraft', targets }),
      // The gizmo can also be dragged directly; its offset is folded back into state
      // so the slider, the slice solve and the project file all agree on one plane.
      onSectionPlaneChange: (plane) =>
        dispatch({ type: 'view/patchSection', patch: { offset: planeOffset(plane) } }),
    }),
    [dispatch, hoverStore],
  );
  const { containerRef, scene } = useThermalScene(handlers);

  useEffect(() => {
    return () => {
      solveRunnerRef.current?.dispose();
      importRunnerRef.current?.dispose();
    };
  }, []);

  // -- geometry ------------------------------------------------------------
  // setModel resets overrides, selection and the section, so everything else the
  // viewer holds is re-applied here in one place.
  const lastModelRef = useRef<ThermalModel | null>(null);
  useEffect(() => {
    if (!scene) return;
    const inPlaceEdit = lastModelRef.current === model && model !== null;
    const heldCamera = inPlaceEdit ? scene.getCameraView() : null;
    scene.setModel(model);
    lastModelRef.current = model;
    if (!model) return;
    const current = stateRef.current;
    scene.setScenario(current.scenario);
    scene.setTemperatures(
      temperatureRef.current,
      current.scenario.colorScale,
      current.scenario.ambient,
    );
    applyViewerState(scene, current.viewer, sectionOffsetRef.current);
    const camera = heldCamera ?? current.viewer.camera;
    if (camera) scene.setCameraView(camera);
  }, [scene, model, modelRevision, stateRef, temperatureRef, sectionOffsetRef]);

  // -- scenario, field and colour -------------------------------------------
  useEffect(() => {
    if (scene && model) scene.setScenario(scenario);
  }, [scene, model, scenario]);

  useEffect(() => {
    scene?.setTemperatures(temperature, scenario.colorScale, scenario.ambient);
  }, [scene, temperature, scenario.colorScale, scenario.ambient]);

  // -- selection and display ------------------------------------------------
  useEffect(() => {
    if (!scene) return;
    if (!sameTargets(scene.getSelection(), viewer.selection)) scene.setSelection(viewer.selection);
  }, [scene, viewer.selection]);

  useEffect(() => {
    if (!scene) return;
    if (!sameTargets(scene.getDraft(), viewer.bcDraft)) scene.setDraft(viewer.bcDraft);
  }, [scene, viewer.bcDraft]);

  useEffect(() => {
    scene?.setCollecting(viewer.bcCollecting);
  }, [scene, viewer.bcCollecting]);

  useEffect(() => {
    scene?.setSelectionMode(viewer.selectionMode);
  }, [scene, viewer.selectionMode]);

  useEffect(() => {
    scene?.setWireframe(viewer.wireframe);
  }, [scene, viewer.wireframe]);

  useEffect(() => {
    if (!scene) return;
    for (const kind of OVERLAY_KINDS) scene.setOverlayVisible(kind, viewer.overlays[kind]);
  }, [scene, viewer.overlays]);

  useEffect(() => {
    scene?.setFocusedCavity(viewer.focusedCavity);
  }, [scene, viewer.focusedCavity]);

  // -- theme ----------------------------------------------------------------
  // Not repeated in `applyViewerState`: the scene holds both colours itself, and the
  // mesh `setModel` rebuilds is painted from the one it is already holding.
  useEffect(() => {
    if (!scene) return;
    scene.setBackground(BACKGROUND_COLORS[resolved]);
    scene.setNoDataColor(NO_DATA_COLORS[resolved]);
  }, [scene, resolved]);

  // -- section plane --------------------------------------------------------
  useEffect(() => {
    if (!scene) return;
    scene.setSectionEnabled(section.enabled);
    scene.setSectionClipping(section.clipping);
  }, [scene, section.enabled, section.clipping]);

  useEffect(() => {
    if (!scene) return;
    // Both of these drop the field the slice effect drew, and the gizmo echoes every
    // change back through onSectionPlaneChange, so neither is called unless the plane
    // has genuinely moved.
    const current = scene.getSectionPlane().normal;
    if (!sameVector(current, sectionNormal)) scene.setSectionAxis(section.axis, section.sign);
    if (Math.abs(scene.getSectionOffset() - sectionOffset) > 1e-9) {
      scene.setSectionOffset(sectionOffset);
    }
  }, [scene, section.axis, section.sign, sectionNormal, sectionOffset]);

  // The cut outlines, and the approximate 2D field solved inside them.
  const cavityFillK = useMemo(() => dominantFillK(scenario.cavities), [scenario.cavities]);
  useEffect(() => {
    if (!scene) return;
    // Everything happens on the timer, including clearing: a gizmo drag would
    // otherwise queue a 256² Gauss-Seidel solve per frame.
    const timer = setTimeout(() => {
      if (!model || !section.enabled || !sectionPlane) {
        scene.setSectionField(null);
        setSlice(null);
        setSliceStatus(section.enabled ? 'No model.' : 'Section is off.');
        return;
      }
      const basis = planeBasis(sectionPlane);
      const labels = { uLabel: axisLabel(basis.axisU), vLabel: axisLabel(basis.axisV) };
      const polylines: SectionPolylineDetail[] = sectionModel(model, sectionPlane, {
        temperature: temperature ?? undefined,
      });
      if (polylines.length === 0) {
        scene.setSectionField(null);
        setSlice({ polylines, field: null, ...labels });
        setSliceStatus('The plane misses the model.');
        return;
      }
      if (!section.showField) {
        scene.setSectionField(null);
        setSlice({ polylines, field: null, ...labels });
        setSliceStatus(`${polylines.length} cut outlines · field off.`);
        return;
      }
      const field = solveSliceField(polylines, basis, {
        extent: sectionExtent(model.bbox, sectionPlane),
        ambient: scenario.ambient,
        fillK: cavityFillK,
        width: section.resolution,
        height: section.resolution,
      });
      scene.setSectionField(field, {
        map: resolvedScale.map,
        min: resolvedScale.min,
        max: resolvedScale.max,
      });
      setSlice({ polylines, field, ...labels });
      setSliceStatus(
        `${polylines.length} cut outlines · ${section.resolution}² grid · fill k = ${cavityFillK} W/m·K`,
      );
    }, SLICE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    scene,
    model,
    sectionPlane,
    section.enabled,
    section.showField,
    section.resolution,
    temperature,
    scenario.ambient,
    cavityFillK,
    resolvedScale,
  ]);

  // -- actions --------------------------------------------------------------

  const resetView = useCallback(() => scene?.resetView(), [scene]);

  const runSolve = useCallback(async () => {
    const current = stateRef.current;
    if (!current.model) return;
    const runner = (solveRunnerRef.current ??= new SolveRunner());
    dispatch({ type: 'solve/started' });
    try {
      const result = await runner.solve({
        model: current.model,
        scenario: current.scenario,
        previous: current.scenario.solver.warmStart ? current.solve.result?.temperature : null,
        materials: current.custom.materials,
        finishes: current.custom.finishes,
      });
      dispatch({ type: 'solve/succeeded', result });
    } catch (error) {
      if ((error as Error).name === SUPERSEDED_SOLVE) return;
      dispatch({ type: 'solve/failed', message: describeError(error) });
    }
  }, [dispatch, stateRef]);

  const importFile = useCallback(
    async (file: File, settings: ImportSettings) => {
      const runner = (importRunnerRef.current ??= new ImportRunner());
      dispatch({ type: 'import/started', filename: file.name });
      try {
        const bytes = await readFileBytes(file);
        // Hash before the buffer is transferred into the worker, which detaches it.
        const hash = await hashBytes(new Uint8Array(bytes));
        const product = await runner.run(file.name, bytes, settings, (stage) =>
          dispatch({ type: 'import/stage', stage }),
        );
        dispatch({
          type: 'model/loaded',
          model: product.model,
          cavities: product.cavities,
          contacts: product.contacts,
          source: { name: file.name, hash, units: product.model.sourceUnits },
        });
      } catch (error) {
        dispatch({ type: 'import/failed', message: describeError(error) });
      }
    },
    [dispatch],
  );

  const openProjectFile = useCallback(
    async (file: File) => {
      dispatch({ type: 'import/started', filename: file.name });
      try {
        const parsed = parseProjectFile(await readFileText(file));
        const opened = openProject(parsed, stateRef.current.model);
        registerCustomLibrary({
          materials: opened.customMaterials,
          finishes: opened.customFinishes,
        });
        dispatch({ type: 'project/opened', opened: withMaterialIssues(opened) });
        dispatch({ type: 'import/dismiss' });
      } catch (error) {
        dispatch({ type: 'import/failed', message: describeError(error) });
      }
    },
    [dispatch, stateRef],
  );

  const saveProject = useCallback(() => {
    const current = stateRef.current;
    const viewerState: ViewerState = {
      ...current.viewer,
      camera: scene?.getCameraView() ?? current.viewer.camera,
    };
    const snapshot: ProjectSnapshot = {
      source: current.source,
      scenario: current.scenario,
      viewer: viewerState,
      customMaterials: current.custom.materials,
      customFinishes: current.custom.finishes,
      model: current.model,
      embedMesh,
    };
    downloadText(suggestProjectFilename(current.source?.name ?? null), serialiseProject(snapshot));
  }, [embedMesh, scene, stateRef]);

  const acceptFile = useCallback(
    (file: File) => {
      if (isProjectFilename(file.name)) {
        void openProjectFile(file);
        return;
      }
      const format = formatFromFilename(file.name);
      if (!format) {
        dispatch({ type: 'import/started', filename: file.name });
        dispatch({
          type: 'import/failed',
          message: `'${file.name}' is not a format HDS can read. Supported: .step, .stp, .stl, .obj, and .hds.json projects.`,
        });
        return;
      }
      setPendingImport({ file, format });
    },
    [dispatch, openProjectFile],
  );

  // -- hotkeys --------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const mode = SELECTION_MODE_HOTKEYS[event.key];
      if (mode) {
        dispatch({ type: 'view/setSelectionMode', mode });
        return;
      }
      if (event.key === 'w') {
        dispatch({ type: 'view/setWireframe', wireframe: !stateRef.current.viewer.wireframe });
      } else if (event.key === 'f') {
        scene?.resetView();
      } else if (event.key === 'Escape') {
        // Cancelling the group you are building is the nearer instinct than
        // clearing the selection, so the draft goes first.
        if (stateRef.current.viewer.bcDraft.length > 0) {
          dispatch({ type: 'view/setBcDraft', targets: [] });
        } else {
          dispatch({ type: 'view/setSelection', selection: [] });
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dispatch, scene, stateRef]);

  const hasModel = model !== null;

  return (
    <div
      className={dragging ? 'app-shell dragging' : 'app-shell'}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) acceptFile(file);
      }}
    >
      <div className="viewport" ref={containerRef} />

      <header className="panel app-header">
        <h1>HDS — heat dissipation simulator</h1>
        <p>
          {source ? source.name : 'No model loaded'}
          {model ? ` · ${model.parts.length} parts · ${model.triCount} triangles` : ''}
        </p>
      </header>

      <Toolbar
        onImport={() => cadInputRef.current?.click()}
        onOpenProject={() => projectInputRef.current?.click()}
        onSaveProject={saveProject}
        onSolve={() => void runSolve()}
        onResetView={resetView}
        canSolve={hasModel}
        solving={solve.status === 'running'}
        hasModel={hasModel}
        embedMesh={embedMesh}
        onToggleEmbedMesh={() => setEmbedMesh((value) => !value)}
        plotsOpen={plotsOpen}
        onTogglePlots={() => setPlotsOpen((value) => !value)}
      />

      <aside className="column left">
        <PartTreePanel />
        <MaterialsPanel />
        <BoundaryConditionsPanel />
        <ContactsPanel />
        <CavitiesPanel />
      </aside>

      <aside className="column right">
        <ResultsPanel />
        <ColorScalePanel resolved={resolvedScale} />
        <SectionPanel offsetRange={sectionRange} fieldStatus={sliceStatus} />
        <EnvironmentPanel />
        <DisplayPanel onResetView={resetView} />
      </aside>

      {plotsOpen ? (
        <PlotsDock
          model={model}
          scenario={scenario}
          result={solve.result}
          section={slice}
          scale={resolvedScale}
          onClose={() => setPlotsOpen(false)}
        />
      ) : null}

      <Legend
        scale={resolvedScale}
        ambient={scenario.ambient}
        label={temperature ? 'surface temperature' : 'surface temperature (no field yet)'}
      />
      <HoverReadout store={hoverStore} model={model} hasField={temperature !== null} />

      {!hasModel ? (
        <div className="drop-hint">
          <strong>Drop a STEP, STL or OBJ file</strong>
          <span>or a saved .hds.json project</span>
        </div>
      ) : (
        <div className="hint-bar">
          drag to rotate · shift-drag or right-drag to pan · scroll to zoom · 1–4 selection modes ·
          w wireframe · f frame
        </div>
      )}

      <StatusOverlay />
      {pendingImport ? (
        <ImportDialog
          filename={pendingImport.file.name}
          sizeBytes={pendingImport.file.size}
          format={pendingImport.format}
          settings={importSettings}
          onChange={(patch) => dispatch({ type: 'import/settings', patch })}
          onCancel={() => setPendingImport(null)}
          onConfirm={() => {
            const pending = pendingImport;
            setPendingImport(null);
            void importFile(pending.file, stateRef.current.importSettings);
          }}
        />
      ) : null}

      <input
        ref={cadInputRef}
        type="file"
        accept=".step,.stp,.stl,.obj"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) acceptFile(file);
        }}
      />
      <input
        ref={projectInputRef}
        type="file"
        accept=".json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void openProjectFile(file);
        }}
      />
    </div>
  );
}

/**
 * A project can name a material its custom library no longer carries. Reported on
 * open rather than left for the solve to throw on, which is where it would surface
 * otherwise.
 */
function withMaterialIssues(opened: OpenedProject): OpenedProject {
  const model = opened.model;
  if (!model) return opened;
  const missing = missingLibraryIds(opened.scenario.partOverrides, model.parts);
  if (missing.length === 0) return opened;
  return {
    ...opened,
    issues: [
      ...opened.issues,
      {
        kind: 'material',
        id: missing.join(', '),
        detail: `No material or finish is defined for ${missing.join(', ')}; the parts using them cannot be solved until one is.`,
      },
    ],
  };
}

/** Everything `setModel` clears, put back. */
function applyViewerState(scene: ThermalScene, viewer: ViewerState, sectionOffset: number): void {
  scene.setWireframe(viewer.wireframe);
  scene.setSelectionMode(viewer.selectionMode);
  scene.setSelection(viewer.selection);
  scene.setDraft(viewer.bcDraft);
  scene.setCollecting(viewer.bcCollecting);
  for (const kind of OVERLAY_KINDS) scene.setOverlayVisible(kind, viewer.overlays[kind]);
  scene.setSectionEnabled(viewer.section.enabled);
  scene.setSectionClipping(viewer.section.clipping);
  scene.setSectionAxis(viewer.section.axis, viewer.section.sign);
  scene.setSectionOffset(sectionOffset);
}

/** The cut-plane fill takes one conductivity; the biggest cavity is the one that shows. */
function dominantFillK(cavities: ProjectState['scenario']['cavities']): number {
  let best: { triCount: number; fillK: number } | null = null;
  for (const cavity of cavities) {
    if (!best || cavity.triCount > best.triCount) best = cavity;
  }
  return best ? best.fillK : CAVITY_DEFAULTS.stillAir.fillK;
}

function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

/** Names an in-plane axis by the world axis it mostly follows, for the plot captions. */
function axisLabel(axis: Vec3): string {
  let dominant = 0;
  for (let k = 1; k < 3; k++) if (Math.abs(axis[k]) > Math.abs(axis[dominant])) dominant = k;
  return `${axis[dominant] < 0 ? '−' : ''}${['X', 'Y', 'Z'][dominant]}  [mm]`;
}

function sameVector(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
