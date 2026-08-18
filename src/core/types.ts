/**
 * The shared contract between geometry, physics, analysis, viewer and ui.
 *
 * Rule: `physics/` and `analysis/` may import from here and from each other, but
 * never from `viewer/`, `ui/`, or three.js. They take typed arrays in and return
 * typed arrays out, so the solver stays testable in Node and a volumetric backend
 * can be swapped in behind `ThermalSolver` later.
 *
 * Units are SI everywhere below this line: metres, kelvin, watts. Conversion from
 * CAD units and to display °C happens at the edges (`core/units.ts`, `ui/`).
 */

export type Vec3 = readonly [number, number, number];

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * How a part conducts. `sheet` spreads heat in plane through `k × thickness` and is
 * isothermal across its thickness; `lump` is one temperature throughout; `solid` fills
 * the part with cells and conducts in three dimensions, which is what a thick low-k
 * body — insulation above all — needs to drop its gradient across itself instead of
 * short-circuiting along its own skin; `insulator` leaves the system entirely.
 */
export type BodyType = 'sheet' | 'lump' | 'solid' | 'insulator';

export interface Part {
  id: string;
  /** As named in the CAD assembly, e.g. 'housing'. Falls back to 'part N'. */
  name: string;
  bodyType: BodyType;
  materialId: string;
  finishId: string;
  /** Metres. Used when bodyType === 'sheet'. */
  thickness: number;
  /** Half-open triangle range [start, end) into ThermalModel.tris. */
  triRange: readonly [number, number];
  /** Half-open node range [start, end) into ThermalModel.nodes. */
  nodeRange: readonly [number, number];
  /** Signed volume of the closed shell, m³. Zero for open shells. */
  volume: number;
  surfaceArea: number;
  /**
   * 6·volume / (surfaceArea · bboxDiagonal). Thin shells score low, chunky
   * solids high. Drives the initial bodyType guess and is shown in the UI so the
   * guess is inspectable rather than magic.
   */
  thinnessRatio: number;
  bbox: Bounds;
}

/** A chain of feature edges (dihedral angle above threshold), for selection and overlay. */
export interface EdgeChain {
  id: number;
  partIndex: number;
  /** Node indices in path order. Closed loops repeat the first node at the end. */
  nodes: Uint32Array;
}

/**
 * The output of import and the input to everything else.
 *
 * Nodes are welded within a part (tessellators emit duplicates at every face
 * seam; unwelded, an assembly is thermally disconnected) but deliberately NOT
 * across parts — inter-part flow goes through explicit Contacts so it can carry
 * a finite conductance.
 */
export interface ThermalModel {
  /** Welded positions, xyz interleaved, metres. length = 3 × nodeCount */
  nodes: Float32Array;
  /** Triangle indices into nodes. length = 3 × triCount */
  tris: Uint32Array;

  triPart: Uint32Array;
  /** Face-region index: B-rep face for STEP, dihedral-derived region otherwise. */
  triFace: Uint32Array;
  /** m² */
  triArea: Float32Array;
  /** Unit outward normals, xyz interleaved. */
  triNormal: Float32Array;
  /** 0 = open air, otherwise a cavity id indexing Scenario.cavities. */
  triCavity: Uint8Array;

  nodePart: Uint32Array;
  /** Sum of ⅓ of each incident triangle's area — the area a node exchanges through. m² */
  nodeArea: Float32Array;

  parts: Part[];
  featureEdges: EdgeChain[];
  bbox: Bounds;
  sourceUnits: 'mm' | 'm' | 'in';

  nodeCount: number;
  triCount: number;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export interface Material {
  id: string;
  name: string;
  /** Thermal conductivity, W/(m·K). */
  k: number;
  /** kg/m³ — unused by the steady-state solver, carried for a future transient mode. */
  density?: number;
  /** J/(kg·K) — likewise. */
  specificHeat?: number;
  category: 'metal' | 'polymer' | 'ceramic' | 'insulation' | 'fluid' | 'custom';
}

/**
 * Emissivity is a surface property, not a bulk one: bare SS304 is ≈0.15, the same
 * steel painted is ≈0.9, and on a 200 °C part that difference dominates total loss.
 * Keeping finish separate from material is deliberate.
 */
export interface SurfaceFinish {
  id: string;
  name: string;
  /** Hemispherical total emissivity, 0..1 */
  emissivity: number;
}

// ---------------------------------------------------------------------------
// Scenario — everything the user sets
// ---------------------------------------------------------------------------

export type TargetType = 'part' | 'face' | 'edge' | 'node';

export type Target =
  | { type: 'part'; partId: string }
  | { type: 'face'; partId: string; faceId: number }
  | { type: 'edge'; partId: string; edgeId: number }
  | { type: 'node'; partId: string; nodeId: number };

/**
 * One condition over a *set* of targets: six faces of a housing at 200 °C are one
 * row carrying one value, not six. `targets` is non-empty — a condition naming
 * nothing is meaningless — and deduplicated by `targetKey`, so the union of nodes
 * a member claims is counted once. Every write path enforces both.
 */
export type BoundaryCondition =
  | {
      id: string;
      kind: 'fixedTemp';
      targets: Target[];
      /** kelvin */ value: number;
      enabled: boolean;
    }
  | {
      id: string;
      kind: 'heatLoad';
      targets: Target[];
      /** watts, total over the whole group */ watts: number;
      enabled: boolean;
    }
  | {
      id: string;
      kind: 'convection';
      targets: Target[];
      /** W/(m²·K), or 'auto' for the correlation */ h: number | 'auto';
      enabled: boolean;
    };

export interface Contact {
  id: string;
  partA: string;
  partB: string;
  /** Paired node indices; nodePairs[2i] on partA, nodePairs[2i+1] on partB. */
  nodePairs: Uint32Array;
  /** Contact area attributed to each pair, m². Same length as nodePairs/2. */
  pairArea: Float32Array;
  /** Contact conductance, W/(m²·K). PERFECT_CONTACT for a welded/bonded joint. */
  conductance: number;
  /** True when produced by proximity detection rather than added by hand. */
  autoDetected: boolean;
  enabled: boolean;
}

export const PERFECT_CONTACT = 1e6;

export type CavityCondition = 'stillAir' | 'insulated' | 'adiabatic';

export interface Cavity {
  id: number;
  name: string;
  condition: CavityCondition;
  /** Effective film coefficient for surfaces facing this cavity, W/(m²·K). */
  h: number;
  /** Effective emissivity inside the enclosure, 0..1. */
  emissivity: number;
  /** Conductivity of whatever fills it — used by the 2D cut-plane solve. W/(m·K) */
  fillK: number;
  triCount: number;
}

export type ColormapId = 'inferno' | 'viridis' | 'turbo' | 'coolwarm';

export interface ColorScale {
  mode: 'auto' | 'ambientToMax' | 'manual';
  /** kelvin. Honoured when mode === 'manual'; otherwise written by the solve. */
  min: number;
  max: number;
  map: ColormapId;
}

export interface PartOverride {
  bodyType?: BodyType;
  materialId?: string;
  finishId?: string;
  thickness?: number;
  visible?: boolean;
  opacity?: number;
}

export interface Scenario {
  /** kelvin */
  ambient: number;
  /** Unit vector the buoyancy correlations treat as "down". Default (0,0,-1). */
  gravity: Vec3;
  partOverrides: Record<string, PartOverride>;
  boundaryConditions: BoundaryCondition[];
  contacts: Contact[];
  cavities: Cavity[];
  colorScale: ColorScale;
  solver: SolverSettings;
}

export interface SolverSettings {
  /** Picard outer loop stops below this max |ΔT| in kelvin. */
  tolerance: number;
  maxOuterIterations: number;
  /** Conjugate gradient inner loop. */
  cgTolerance: number;
  maxCgIterations: number;
  /** Reuse the previous solution as the initial guess. Cuts outer iterations to 2–3. */
  warmStart: boolean;
}

export const DEFAULT_SOLVER_SETTINGS: SolverSettings = {
  tolerance: 0.01,
  maxOuterIterations: 40,
  cgTolerance: 1e-8,
  maxCgIterations: 5000,
  warmStart: true,
};

// ---------------------------------------------------------------------------
// Solve results
// ---------------------------------------------------------------------------

/** Where heat left the model, split so the balance can be shown per part and per mechanism. */
export interface HeatBalance {
  /** Watts injected at fixed-temperature boundaries (negative = extracted). */
  injectedAtFixed: number;
  /** Watts injected by heat loads. */
  injectedAtLoads: number;
  lostByConvection: number;
  lostByRadiation: number;
  /** injected − lost. Must be ~0; a non-zero value is a bug, surfaced not swallowed. */
  residual: number;
  perPart: Array<{
    partId: string;
    convection: number;
    radiation: number;
    injected: number;
  }>;
  perContact: Array<{ contactId: string; watts: number }>;
  /** One entry per cavity with a temperature of its own; empty when none has. */
  perCavity: Array<{
    cavityId: number;
    /** kelvin */
    temperature: number;
    /** Net watts into the cavity. A sealed pocket has nowhere to put them, so ~0. */
    netFlow: number;
  }>;
}

export interface SolveResult {
  /** Node temperatures in kelvin. length = nodeCount */
  temperature: Float32Array;
  minTemp: number;
  maxTemp: number;
  balance: HeatBalance;
  outerIterations: number;
  converged: boolean;
  /** Populated when the run stopped early or the energy residual is out of tolerance. */
  warnings: string[];
  elapsedMs: number;
}

/**
 * The seam the volumetric backend will slot into later. Implementations must not
 * mutate their inputs.
 */
export interface ThermalSolver {
  readonly id: 'shell' | 'voxel';
  solve(
    model: ThermalModel,
    scenario: Scenario,
    /** Previous solution for warm-starting, if any. */
    previous?: Float32Array,
  ): Promise<SolveResult>;
}

// ---------------------------------------------------------------------------
// Analysis outputs
// ---------------------------------------------------------------------------

export interface SectionPlane {
  /** Unit normal. */
  normal: Vec3;
  /** A point on the plane, metres. */
  origin: Vec3;
}

/** One connected polyline where the section plane crosses the shell. */
export interface SectionPolyline {
  partId: string;
  /** Points in 3D, xyz interleaved, in path order. */
  points: Float32Array;
  /** Temperature at each point, kelvin. length = points.length / 3 */
  temperature: Float32Array;
  /** Cumulative arc length at each point, metres. */
  arcLength: Float32Array;
  closed: boolean;
}

export interface SectionField2D {
  /** Grid dimensions. */
  width: number;
  height: number;
  /** Plane-space extent of the grid, metres. */
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  /** Temperature per cell, kelvin. NaN where the cell is outside the model. */
  values: Float32Array;
  /** Per-cell classification, for rendering and debugging. */
  mask: Uint8Array;
  contours: Array<{ level: number; segments: Float32Array }>;
}

export const CELL_OUTSIDE = 0;
export const CELL_SHELL = 1;
export const CELL_CAVITY = 2;
export const CELL_AMBIENT = 3;

export interface PathLengthResult {
  /** Shortest conduction path from the source set, metres. Infinity when unreachable. */
  distance: Float32Array;
  /** Least-squares fit of T = Tinf + dT·exp(−s/lambda). */
  fit: {
    /** Fin length λ, metres. */
    lambda: number;
    tInfinity: number;
    deltaT: number;
    rSquared: number;
  } | null;
}

export interface ThresholdResult {
  /** kelvin */
  threshold: number;
  /** m² of surface above the threshold. */
  areaAbove: number;
  totalArea: number;
  perPart: Array<{ partId: string; areaAbove: number }>;
  histogram: {
    binEdges: Float32Array;
    /** Surface area in each bin, m². */
    areaPerBin: Float32Array;
  };
}
