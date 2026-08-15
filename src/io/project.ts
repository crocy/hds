/**
 * `.hds.json` project files — spec §9.
 *
 * A project is the whole `Scenario`, the view, the custom material library, and a
 * reference to the CAD file by name and content hash. The tessellated mesh can be
 * embedded, in which case the project opens standalone; without it the same CAD file
 * has to be imported first and the scenario is re-resolved against the new geometry.
 *
 * Re-resolution never drops an entity quietly. Every part override, boundary
 * condition, contact and cavity that no longer names anything in the model comes back
 * as a `ProjectIssue` for the UI to show.
 */

import type {
  Bounds,
  Contact,
  EdgeChain,
  Material,
  Part,
  Scenario,
  SurfaceFinish,
  Target,
  ThermalModel,
} from '@/core/types';
import type { LengthUnit } from '@/core/units';
import { resolveTargetNodes } from '@/physics/assemble';
import { DEFAULT_VIEWER_STATE, type ViewerState } from '@/ui/state/viewerState';
import { decodeAs, encodeBinaryArray, type BinaryArray } from './binary';

export const PROJECT_FORMAT = 'hds.project';
export const PROJECT_VERSION = 1;
export const PROJECT_EXTENSION = '.hds.json';

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFormatError';
  }
}

export interface ProjectSource {
  /** File name as imported, e.g. 'ohisje - TBTE 2x116.step'. */
  name: string;
  /** Algorithm-prefixed content hash; see `io/hash`. */
  hash: string;
  units: LengthUnit;
}

export interface SerialisedContact extends Omit<Contact, 'nodePairs' | 'pairArea'> {
  nodePairs: BinaryArray;
  pairArea: BinaryArray;
}

export interface SerialisedScenario extends Omit<Scenario, 'contacts'> {
  contacts: SerialisedContact[];
}

export interface SerialisedEdgeChain {
  id: number;
  partIndex: number;
  nodes: BinaryArray;
}

export interface SerialisedModel {
  nodes: BinaryArray;
  tris: BinaryArray;
  triPart: BinaryArray;
  triFace: BinaryArray;
  triArea: BinaryArray;
  triNormal: BinaryArray;
  triCavity: BinaryArray;
  nodePart: BinaryArray;
  nodeArea: BinaryArray;
  parts: Part[];
  featureEdges: SerialisedEdgeChain[];
  bbox: Bounds;
  sourceUnits: LengthUnit;
  nodeCount: number;
  triCount: number;
}

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: number;
  savedAt: string;
  source: ProjectSource | null;
  scenario: SerialisedScenario;
  viewer: ViewerState;
  customMaterials: Material[];
  customFinishes: SurfaceFinish[];
  /** Present when the user asked for a standalone project. */
  mesh: SerialisedModel | null;
}

export type ProjectIssueKind =
  'geometry' | 'source' | 'partOverride' | 'boundaryCondition' | 'contact' | 'cavity' | 'material';

export interface ProjectIssue {
  kind: ProjectIssueKind;
  /** Id of the entity that could not be resolved, for the UI to name it. */
  id: string;
  detail: string;
}

export interface ProjectSnapshot {
  source: ProjectSource | null;
  scenario: Scenario;
  viewer: ViewerState;
  customMaterials: Material[];
  customFinishes: SurfaceFinish[];
  model: ThermalModel | null;
  embedMesh: boolean;
}

export interface OpenedProject {
  scenario: Scenario;
  viewer: ViewerState;
  /** The embedded mesh, or null when the project relies on re-importing the CAD file. */
  model: ThermalModel | null;
  source: ProjectSource | null;
  customMaterials: Material[];
  customFinishes: SurfaceFinish[];
  issues: ProjectIssue[];
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export function createProjectFile(snapshot: ProjectSnapshot): ProjectFile {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    source: snapshot.source,
    scenario: serialiseScenario(snapshot.scenario),
    viewer: snapshot.viewer,
    customMaterials: snapshot.customMaterials,
    customFinishes: snapshot.customFinishes,
    mesh: snapshot.embedMesh && snapshot.model ? serialiseModel(snapshot.model) : null,
  };
}

export function serialiseProject(snapshot: ProjectSnapshot): string {
  return JSON.stringify(createProjectFile(snapshot));
}

export function serialiseScenario(scenario: Scenario): SerialisedScenario {
  return {
    ...scenario,
    contacts: scenario.contacts.map((contact) => ({
      ...contact,
      nodePairs: encodeBinaryArray(contact.nodePairs),
      pairArea: encodeBinaryArray(contact.pairArea),
    })),
  };
}

export function serialiseModel(model: ThermalModel): SerialisedModel {
  return {
    nodes: encodeBinaryArray(model.nodes),
    tris: encodeBinaryArray(model.tris),
    triPart: encodeBinaryArray(model.triPart),
    triFace: encodeBinaryArray(model.triFace),
    triArea: encodeBinaryArray(model.triArea),
    triNormal: encodeBinaryArray(model.triNormal),
    triCavity: encodeBinaryArray(model.triCavity),
    nodePart: encodeBinaryArray(model.nodePart),
    nodeArea: encodeBinaryArray(model.nodeArea),
    parts: model.parts,
    featureEdges: model.featureEdges.map((chain) => ({
      id: chain.id,
      partIndex: chain.partIndex,
      nodes: encodeBinaryArray(chain.nodes),
    })),
    bbox: model.bbox,
    sourceUnits: model.sourceUnits,
    nodeCount: model.nodeCount,
    triCount: model.triCount,
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function parseProjectFile(text: string): ProjectFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ProjectFormatError(`Not a JSON file: ${(error as Error).message}`);
  }
  const file = parsed as Partial<ProjectFile>;
  if (!file || typeof file !== 'object' || file.format !== PROJECT_FORMAT) {
    throw new ProjectFormatError(
      `Not an HDS project: expected "format": "${PROJECT_FORMAT}", found ${JSON.stringify(
        (file as { format?: unknown })?.format ?? null,
      )}`,
    );
  }
  if (file.version !== PROJECT_VERSION) {
    throw new ProjectFormatError(
      `Project format version ${String(file.version)} cannot be read by this build, which writes version ${PROJECT_VERSION}`,
    );
  }
  if (!file.scenario || typeof file.scenario !== 'object') {
    throw new ProjectFormatError('Project has no scenario');
  }
  return file as ProjectFile;
}

/**
 * Turns a parsed file into the state the app runs on, resolved against whichever
 * geometry is available: the embedded mesh, or a model the user imported first.
 */
export function openProject(file: ProjectFile, importedModel: ThermalModel | null): OpenedProject {
  const issues: ProjectIssue[] = [];
  let model: ThermalModel | null = null;
  if (file.mesh) {
    try {
      model = deserialiseModel(file.mesh);
    } catch (error) {
      issues.push({
        kind: 'geometry',
        id: file.source?.name ?? 'mesh',
        detail: `The embedded mesh could not be read (${(error as Error).message}); the scenario was kept unresolved`,
      });
    }
  }
  const geometry = model ?? importedModel;
  const scenario = deserialiseScenario(file.scenario);
  const resolved = geometry
    ? resolveScenarioAgainstModel(scenario, geometry)
    : { scenario, issues: [] as ProjectIssue[] };
  issues.push(...resolved.issues);

  if (!geometry) {
    issues.push({
      kind: 'geometry',
      id: file.source?.name ?? 'unknown',
      detail:
        'This project does not embed its mesh. Import the CAD file it names, then open the project again to bind the scenario to it.',
    });
  }

  return {
    scenario: resolved.scenario,
    viewer: normaliseViewerState(file.viewer, geometry),
    model,
    source: file.source ?? null,
    customMaterials: Array.isArray(file.customMaterials) ? file.customMaterials : [],
    customFinishes: Array.isArray(file.customFinishes) ? file.customFinishes : [],
    issues,
  };
}

export function deserialiseScenario(serialised: SerialisedScenario): Scenario {
  return {
    ...serialised,
    contacts: serialised.contacts.map((contact, index) => ({
      ...contact,
      nodePairs: decodeAs(contact.nodePairs, 'u32', `contacts[${index}].nodePairs`),
      pairArea: decodeAs(contact.pairArea, 'f32', `contacts[${index}].pairArea`),
    })),
  };
}

export function deserialiseModel(serialised: SerialisedModel): ThermalModel {
  const nodeCount = serialised.nodeCount;
  const triCount = serialised.triCount;
  const model: ThermalModel = {
    nodes: decodeAs(serialised.nodes, 'f32', 'mesh.nodes'),
    tris: decodeAs(serialised.tris, 'u32', 'mesh.tris'),
    triPart: decodeAs(serialised.triPart, 'u32', 'mesh.triPart'),
    triFace: decodeAs(serialised.triFace, 'u32', 'mesh.triFace'),
    triArea: decodeAs(serialised.triArea, 'f32', 'mesh.triArea'),
    triNormal: decodeAs(serialised.triNormal, 'f32', 'mesh.triNormal'),
    triCavity: decodeAs(serialised.triCavity, 'u8', 'mesh.triCavity'),
    nodePart: decodeAs(serialised.nodePart, 'u32', 'mesh.nodePart'),
    nodeArea: decodeAs(serialised.nodeArea, 'f32', 'mesh.nodeArea'),
    parts: serialised.parts ?? [],
    featureEdges: (serialised.featureEdges ?? []).map((chain, index): EdgeChain => ({
      id: chain.id,
      partIndex: chain.partIndex,
      nodes: decodeAs(chain.nodes, 'u32', `mesh.featureEdges[${index}].nodes`),
    })),
    bbox: serialised.bbox,
    sourceUnits: serialised.sourceUnits,
    nodeCount,
    triCount,
  };

  expectLength('mesh.nodes', model.nodes.length, nodeCount * 3);
  expectLength('mesh.nodePart', model.nodePart.length, nodeCount);
  expectLength('mesh.nodeArea', model.nodeArea.length, nodeCount);
  expectLength('mesh.tris', model.tris.length, triCount * 3);
  expectLength('mesh.triPart', model.triPart.length, triCount);
  expectLength('mesh.triFace', model.triFace.length, triCount);
  expectLength('mesh.triArea', model.triArea.length, triCount);
  expectLength('mesh.triNormal', model.triNormal.length, triCount * 3);
  expectLength('mesh.triCavity', model.triCavity.length, triCount);
  return model;
}

function expectLength(field: string, actual: number, expected: number): void {
  if (actual === expected) return;
  throw new ProjectFormatError(`${field}: expected ${expected} elements, found ${actual}`);
}

// ---------------------------------------------------------------------------
// Re-resolution
// ---------------------------------------------------------------------------

/**
 * Drops every scenario entity that no longer names anything in `model`, and reports
 * each one. Boundary conditions are checked with the solver's own
 * `resolveTargetNodes`, so "the UI thinks it resolves" and "the solve will apply it"
 * cannot disagree.
 */
export function resolveScenarioAgainstModel(
  scenario: Scenario,
  model: ThermalModel,
): { scenario: Scenario; issues: ProjectIssue[] } {
  const issues: ProjectIssue[] = [];
  const partIds = new Set(model.parts.map((part) => part.id));

  const partOverrides: Scenario['partOverrides'] = {};
  let droppedOverride = false;
  for (const [partId, override] of Object.entries(scenario.partOverrides)) {
    if (partIds.has(partId)) {
      partOverrides[partId] = override;
      continue;
    }
    droppedOverride = true;
    issues.push({
      kind: 'partOverride',
      id: partId,
      detail: `No part named '${partId}' in this model; its material, thickness and visibility settings were dropped`,
    });
  }

  const boundaryConditions = scenario.boundaryConditions.filter((condition) => {
    const problem = describeUnresolvableTarget(model, partIds, condition.target);
    if (!problem) return true;
    issues.push({
      kind: 'boundaryCondition',
      id: condition.id,
      detail: `${condition.kind} on ${describeTargetBriefly(condition.target)}: ${problem}`,
    });
    return false;
  });

  const contacts = scenario.contacts.filter((contact) => {
    const problem = describeUnresolvableContact(model, partIds, contact);
    if (!problem) return true;
    issues.push({
      kind: 'contact',
      id: contact.id,
      detail: `${contact.partA} ↔ ${contact.partB}: ${problem}`,
    });
    return false;
  });

  const cavityTriangles = countTrianglesPerCavity(model);
  const cavities = scenario.cavities.filter((cavity) => {
    if ((cavityTriangles.get(cavity.id) ?? 0) > 0) return true;
    issues.push({
      kind: 'cavity',
      id: String(cavity.id),
      detail: `No triangle in this model faces cavity ${cavity.id}; the cavity was dropped`,
    });
    return false;
  });

  const changed =
    droppedOverride ||
    boundaryConditions.length !== scenario.boundaryConditions.length ||
    contacts.length !== scenario.contacts.length ||
    cavities.length !== scenario.cavities.length;

  return {
    scenario: changed
      ? { ...scenario, partOverrides, boundaryConditions, contacts, cavities }
      : scenario,
    issues,
  };
}

function describeUnresolvableTarget(
  model: ThermalModel,
  partIds: ReadonlySet<string>,
  target: Target,
): string | null {
  if (!partIds.has(target.partId)) return `no part named '${target.partId}'`;
  if (resolveTargetNodes(model, target).length === 0) {
    return `the ${target.type} it names has no nodes in this model`;
  }
  return null;
}

function describeUnresolvableContact(
  model: ThermalModel,
  partIds: ReadonlySet<string>,
  contact: Contact,
): string | null {
  if (!partIds.has(contact.partA)) return `no part named '${contact.partA}'`;
  if (!partIds.has(contact.partB)) return `no part named '${contact.partB}'`;
  if (contact.nodePairs.length === 0) return 'it links no nodes';
  for (const node of contact.nodePairs) {
    if (node >= model.nodeCount) {
      return `it links node ${node}, past the end of a ${model.nodeCount}-node model`;
    }
  }
  return null;
}

function countTrianglesPerCavity(model: ThermalModel): Map<number, number> {
  const counts = new Map<number, number>();
  for (let t = 0; t < model.triCount; t++) {
    const cavity = model.triCavity[t];
    if (cavity === 0) continue;
    counts.set(cavity, (counts.get(cavity) ?? 0) + 1);
  }
  return counts;
}

function describeTargetBriefly(target: Target): string {
  switch (target.type) {
    case 'part':
      return `part ${target.partId}`;
    case 'face':
      return `face ${target.faceId} of ${target.partId}`;
    case 'edge':
      return `edge ${target.edgeId} of ${target.partId}`;
    case 'node':
      return `node ${target.nodeId} of ${target.partId}`;
    default:
      return 'an unknown target';
  }
}

/** View state is not physics: unknown values fall back to defaults without complaint. */
function normaliseViewerState(
  viewer: ViewerState | undefined,
  model: ThermalModel | null,
): ViewerState {
  const source = viewer ?? DEFAULT_VIEWER_STATE;
  const partIds = new Set((model?.parts ?? []).map((part) => part.id));
  return {
    ...DEFAULT_VIEWER_STATE,
    ...source,
    overlays: { ...DEFAULT_VIEWER_STATE.overlays, ...source.overlays },
    section: { ...DEFAULT_VIEWER_STATE.section, ...source.section },
    selection: model
      ? (source.selection ?? []).filter((target) => partIds.has(target.partId))
      : (source.selection ?? []),
    camera: source.camera ?? null,
  };
}

/** Formats the mismatch between a project's CAD reference and the file actually loaded. */
export function describeSourceMismatch(
  expected: ProjectSource | null,
  actual: { name: string; hash: string } | null,
): string | null {
  if (!expected || !actual) return null;
  if (expected.hash === actual.hash) return null;
  if (expected.name !== actual.name) {
    return `This project was built on '${expected.name}'; the loaded geometry is '${actual.name}'. Entities that no longer resolve are listed above.`;
  }
  return `'${expected.name}' has changed since this project was saved (different content hash). Entities that no longer resolve are listed above.`;
}
