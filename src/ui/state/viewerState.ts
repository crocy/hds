/**
 * Everything about the view that a project file has to remember.
 *
 * Kept out of `Scenario` because none of it changes the answer — it is where the
 * camera was and what was switched on, not physics. `docs` note: this is the
 * `ViewerState` the design wants in `core/types`; it lives here until that lands.
 */

import type { Target } from '@/core/types';
import type { CameraView, OverlayKind, SectionAxis, SelectionMode } from '@/viewer';

export interface SectionState {
  enabled: boolean;
  /** Whether the plane cuts the mesh away or only marks the cut. */
  clipping: boolean;
  axis: SectionAxis;
  sign: 1 | -1;
  /** Signed distance along the normal, metres. Null means "wherever the gizmo centred it". */
  offset: number | null;
  /** Solve and draw the 2D field on the plane. */
  showField: boolean;
  /** Grid resolution of that field, cells per side. */
  resolution: number;
}

export interface ViewerState {
  camera: CameraView | null;
  wireframe: boolean;
  overlays: Record<OverlayKind, boolean>;
  selectionMode: SelectionMode;
  selection: Target[];
  /** The group being staged in the boundary-conditions panel, not yet a condition. */
  bcDraft: Target[];
  /** Whether viewer clicks add to `bcDraft` instead of moving the selection. */
  bcCollecting: boolean;
  section: SectionState;
}

export const DEFAULT_SECTION_STATE: SectionState = {
  enabled: false,
  clipping: true,
  axis: 'x',
  sign: 1,
  offset: null,
  showField: true,
  resolution: 192,
};

export const DEFAULT_VIEWER_STATE: ViewerState = {
  camera: null,
  wireframe: false,
  overlays: {
    contacts: false,
    fixedTemp: true,
    heatLoad: true,
    cavities: false,
    featureEdges: false,
  },
  selectionMode: 'part',
  selection: [],
  bcDraft: [],
  bcCollecting: false,
  section: DEFAULT_SECTION_STATE,
};
