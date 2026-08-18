/**
 * The whole application state, and the one reducer that moves it.
 *
 * `Scenario` is the single source of truth for everything persistent and is edited
 * only through `scenarioReducer`; everything else here is session state — what is
 * loading, what the last solve returned, what the view is showing.
 *
 * The reducer is pure and lives apart from the React context so it can be tested
 * without a renderer.
 */

import { createDefaultScenario, DEFAULT_AMBIENT_C } from '@/core/defaults';
import type { Cavity, Contact, Scenario, SolveResult, Target, ThermalModel } from '@/core/types';
import { sameTargets } from '@/core/targets';
import type { ImportSettings, ImportStage } from '@/io/importPipeline';
import type { OpenedProject, ProjectIssue, ProjectSource } from '@/io/project';
import { DEFAULT_IMPORT_SETTINGS } from '@/io/importPipeline';
import { EMPTY_CUSTOM_LIBRARY, type CustomLibrary } from './materialLibrary';
import { isScenarioAction, scenarioReducer, type ScenarioAction } from './scenarioReducer';
import { DEFAULT_VIEWER_STATE, type SectionState, type ViewerState } from './viewerState';
import type { CameraView, OverlayKind, SelectionMode } from '@/viewer';

export type ImportStatus = 'idle' | 'running' | 'error';

export interface ImportState {
  status: ImportStatus;
  filename: string | null;
  stage: ImportStage | null;
  error: string | null;
  startedAt: number | null;
}

export type SolveStatus = 'idle' | 'running' | 'done' | 'error';

export interface SolveState {
  status: SolveStatus;
  result: SolveResult | null;
  error: string | null;
  startedAt: number | null;
  /** The scenario has changed since this result was produced. */
  stale: boolean;
}

export interface ProjectState {
  model: ThermalModel | null;
  /**
   * Bumped when the model's own arrays are edited in place — reassigning a face to
   * a cavity, say. The viewer has no way to be told "the same model changed", so the
   * effect that pushes geometry watches this alongside the model itself.
   */
  modelRevision: number;
  source: ProjectSource | null;
  scenario: Scenario;
  custom: CustomLibrary;
  viewer: ViewerState;
  solve: SolveState;
  import: ImportState;
  importSettings: ImportSettings;
  /** Entities a loaded project could not bind to the geometry. Shown, never swallowed. */
  issues: ProjectIssue[];
}

export type ProjectAction =
  | ScenarioAction
  | { type: 'import/started'; filename: string }
  | { type: 'import/stage'; stage: ImportStage }
  | { type: 'import/failed'; message: string }
  | { type: 'import/dismiss' }
  | { type: 'import/settings'; patch: Partial<ImportSettings> }
  | {
      type: 'model/loaded';
      model: ThermalModel;
      source: ProjectSource | null;
      cavities: Cavity[];
      contacts: Contact[];
    }
  | { type: 'model/mutated' }
  | { type: 'model/cleared' }
  | { type: 'project/opened'; opened: OpenedProject }
  | { type: 'project/dismissIssues' }
  | { type: 'solve/started' }
  | { type: 'solve/succeeded'; result: SolveResult }
  | { type: 'solve/failed'; message: string }
  | { type: 'view/setWireframe'; wireframe: boolean }
  | { type: 'view/setOverlay'; kind: OverlayKind; visible: boolean }
  | { type: 'view/setSelectionMode'; mode: SelectionMode }
  | { type: 'view/setSelection'; selection: Target[] }
  | { type: 'view/patchSection'; patch: Partial<SectionState> }
  | { type: 'view/setCamera'; camera: CameraView }
  | { type: 'library/set'; custom: CustomLibrary };

export function createInitialState(): ProjectState {
  return {
    model: null,
    modelRevision: 0,
    source: null,
    scenario: createDefaultScenario(DEFAULT_AMBIENT_C),
    custom: EMPTY_CUSTOM_LIBRARY,
    viewer: DEFAULT_VIEWER_STATE,
    solve: { status: 'idle', result: null, error: null, startedAt: null, stale: false },
    import: { status: 'idle', filename: null, stage: null, error: null, startedAt: null },
    importSettings: DEFAULT_IMPORT_SETTINGS,
    issues: [],
  };
}

export function projectReducer(state: ProjectState, action: ProjectAction): ProjectState {
  if (isScenarioAction(action)) {
    const scenario = scenarioReducer(state.scenario, action);
    if (scenario === state.scenario) return state;
    return {
      ...state,
      scenario,
      solve: affectsSolution(action) ? staleSolve(state.solve) : state.solve,
    };
  }

  switch (action.type) {
    case 'import/started':
      return {
        ...state,
        import: {
          status: 'running',
          filename: action.filename,
          stage: 'reading',
          error: null,
          startedAt: Date.now(),
        },
      };

    case 'import/stage':
      return state.import.status === 'running'
        ? { ...state, import: { ...state.import, stage: action.stage } }
        : state;

    case 'import/failed':
      return {
        ...state,
        import: { ...state.import, status: 'error', stage: null, error: action.message },
      };

    case 'import/dismiss':
      return state.import.status === 'idle'
        ? state
        : { ...state, import: { ...state.import, status: 'idle', stage: null, error: null } };

    case 'import/settings':
      return { ...state, importSettings: { ...state.importSettings, ...action.patch } };

    case 'model/loaded': {
      // Ambient, gravity, solver settings and the colour scale are the user's working
      // preferences, not properties of the geometry, so they survive a new import.
      const scenario: Scenario = {
        ...createDefaultScenario(),
        ambient: state.scenario.ambient,
        gravity: state.scenario.gravity,
        solver: state.scenario.solver,
        colorScale: { ...state.scenario.colorScale, mode: 'auto' },
        cavities: action.cavities,
        contacts: action.contacts,
      };
      return {
        ...state,
        model: action.model,
        modelRevision: state.modelRevision + 1,
        source: action.source,
        scenario,
        // The old plane offset means nothing on new geometry; null re-centres it.
        viewer: {
          ...state.viewer,
          selection: [],
          camera: null,
          section: { ...state.viewer.section, offset: null },
        },
        solve: { status: 'idle', result: null, error: null, startedAt: null, stale: false },
        import: { ...state.import, status: 'idle', stage: 'done', error: null },
        issues: [],
      };
    }

    case 'model/mutated':
      return { ...state, modelRevision: state.modelRevision + 1, solve: staleSolve(state.solve) };

    case 'model/cleared':
      return {
        ...createInitialState(),
        importSettings: state.importSettings,
        custom: state.custom,
      };

    case 'project/opened': {
      const { opened } = action;
      const model = opened.model ?? state.model;
      return {
        ...state,
        model,
        modelRevision: state.modelRevision + 1,
        source: opened.source,
        scenario: opened.scenario,
        custom: { materials: opened.customMaterials, finishes: opened.customFinishes },
        viewer: opened.viewer,
        solve: { status: 'idle', result: null, error: null, startedAt: null, stale: false },
        issues: opened.issues,
      };
    }

    case 'project/dismissIssues':
      return state.issues.length === 0 ? state : { ...state, issues: [] };

    case 'solve/started':
      return {
        ...state,
        solve: { ...state.solve, status: 'running', error: null, startedAt: Date.now() },
      };

    case 'solve/succeeded':
      return {
        ...state,
        solve: {
          status: 'done',
          result: action.result,
          error: null,
          startedAt: state.solve.startedAt,
          stale: false,
        },
      };

    case 'solve/failed':
      return {
        ...state,
        solve: { ...state.solve, status: 'error', error: action.message },
      };

    case 'view/setWireframe':
      return { ...state, viewer: { ...state.viewer, wireframe: action.wireframe } };

    case 'view/setOverlay':
      return {
        ...state,
        viewer: {
          ...state.viewer,
          overlays: { ...state.viewer.overlays, [action.kind]: action.visible },
        },
      };

    case 'view/setSelectionMode':
      return state.viewer.selectionMode === action.mode
        ? state
        : { ...state, viewer: { ...state.viewer, selectionMode: action.mode } };

    case 'view/setSelection':
      return sameTargets(state.viewer.selection, action.selection)
        ? state
        : { ...state, viewer: { ...state.viewer, selection: action.selection } };

    case 'view/patchSection': {
      const section = { ...state.viewer.section, ...action.patch };
      // The gizmo echoes back the offset the slider just set; without this the echo
      // would be a fresh object and the two would push each other round forever.
      return shallowEqual(section, state.viewer.section)
        ? state
        : { ...state, viewer: { ...state.viewer, section } };
    }

    case 'view/setCamera':
      return { ...state, viewer: { ...state.viewer, camera: action.camera } };

    case 'library/set':
      return { ...state, custom: action.custom };

    default:
      return state;
  }
}

/** Visibility, colour and camera changes leave the answer alone; everything else does not. */
function affectsSolution(action: ScenarioAction): boolean {
  if (action.type === 'scenario/setColorScale') return false;
  if (action.type === 'parts/isolate' || action.type === 'parts/showAll') return false;
  if (action.type === 'parts/patchOverride') {
    return Object.keys(action.patch).some((key) => key !== 'visible' && key !== 'opacity');
  }
  return true;
}

function shallowEqual(a: object, b: object): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  }
  return true;
}

function staleSolve(solve: SolveState): SolveState {
  if (!solve.result || solve.stale) return solve;
  return { ...solve, stale: true };
}
