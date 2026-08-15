/**
 * The viewer's public surface. The UI imports from `@/viewer` and never reaches
 * into the individual modules, so the split between scene, picking, overlays,
 * colormap and the section gizmo stays an implementation detail.
 *
 * Nothing here imports React; the React layer wraps `ThermalScene` in an effect
 * that mounts it on a div and disposes it on unmount.
 */

export {
  BACKGROUND_COLOR,
  DEFAULT_FOV,
  DEFAULT_PHI,
  DEFAULT_THETA,
  MAX_POLAR,
  MIN_POLAR,
  NO_DATA_COLOR,
  ORBIT_SENSITIVITY,
  ThermalScene,
  ZOOM_STEP,
  boundsCenter,
  boundsDiagonal,
  frameBounds,
  orbitBasis,
  orbitPosition,
  panView,
  rotateView,
  triangleGroups,
  zoomLimitsFor,
  zoomView,
} from './scene';
export type {
  CameraView,
  HoverEvent,
  ResolvedColorScale,
  ThermalSceneHandlers,
  ThermalSceneOptions,
  TriangleGroup,
  ZoomLimits,
} from './scene';

export {
  HOVER_COLOR,
  SELECTION_COLOR,
  SELECTION_MODES,
  SELECTION_MODE_HOTKEYS,
  applySelection,
  describeTarget,
  resolveTarget,
  targetKey,
  targetsEqual,
  worldPerPixel,
} from './picking';
export type { PickHit, SelectionMode } from './picking';

export {
  OVERLAY_COLORS,
  OVERLAY_KINDS,
  OVERLAY_LABELS,
  cavityFaceTriangles,
  contactNodes,
  contactPatchTriangles,
} from './overlays';
export type { OverlayKind } from './overlays';

export {
  SECTION_AXES,
  SECTION_HANDLE_COLOR,
  SECTION_PLANE_COLOR,
  axisNormal,
  clampOffset,
  closestPointOnAxis,
  offsetRange,
  planeFromOffset,
  planeOffset,
  sectionExtent,
  snapNormalToAxis,
  writeSectionFieldTexture,
} from './sectionGizmo';
export type { PlaneExtent, SectionAxis, SectionFieldStyle } from './sectionGizmo';

export {
  COLORMAP_IDS,
  COLORMAP_LABELS,
  cssColor,
  gradientCss,
  isDiverging,
  normalize,
  resolveScaleRange,
  sample,
  symmetricRange,
} from './colormap';
export type { RGB } from './colormap';
