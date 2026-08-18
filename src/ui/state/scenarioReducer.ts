/**
 * The `Scenario` reducer — every persistent edit the user can make.
 *
 * Two rules the rest of the app leans on:
 *
 * 1. **Identity is a signal.** The viewer's overlay layer rebuilds a layer only when
 *    the backing array changes identity, and the React effects that push state into
 *    the scene are keyed the same way. So an action that changes nothing returns the
 *    same state object, and an action that changes one thickness leaves
 *    `contacts`, `cavities` and `boundaryConditions` pointing at their old arrays.
 * 2. **Kelvin in, kelvin out.** Nothing here converts units; the panels do that at
 *    the input boundary.
 */

import { setCavityCondition } from '@/geometry/cavity';
import type {
  BoundaryCondition,
  Cavity,
  CavityCondition,
  ColorScale,
  Contact,
  PartOverride,
  Scenario,
  SolverSettings,
  Target,
  Vec3,
} from '@/core/types';
import { dedupeTargets, sameTargets } from '@/core/targets';

/** Fields of a boundary condition that can be edited without changing its kind. */
export interface BoundaryConditionPatch {
  enabled?: boolean;
  /** kelvin, for `fixedTemp`. */
  value?: number;
  /** watts, for `heatLoad`. */
  watts?: number;
  /** W/(m²·K) or 'auto', for `convection`. */
  h?: number | 'auto';
}

export interface ContactPatch {
  conductance?: number;
  enabled?: boolean;
}

export type CavityPatch = Partial<Pick<Cavity, 'h' | 'emissivity' | 'fillK' | 'name'>>;

export type ScenarioAction =
  | { type: 'scenario/replace'; scenario: Scenario }
  | { type: 'scenario/setAmbient'; ambient: number }
  | { type: 'scenario/setGravity'; gravity: Vec3 }
  | { type: 'scenario/setSolver'; patch: Partial<SolverSettings> }
  | { type: 'scenario/setColorScale'; patch: Partial<ColorScale> }
  | { type: 'parts/patchOverride'; partIds: readonly string[]; patch: PartOverride }
  | { type: 'parts/clearOverride'; partIds: readonly string[] }
  | { type: 'parts/isolate'; partIds: readonly string[]; allPartIds: readonly string[] }
  | { type: 'parts/showAll'; allPartIds: readonly string[] }
  /** Deduplicates the member set; a condition naming nothing is ignored, not added. */
  | { type: 'bc/add'; condition: BoundaryCondition }
  | { type: 'bc/patch'; id: string; patch: BoundaryConditionPatch }
  /** Replaces the whole member set; an empty one is refused, not written. */
  | { type: 'bc/setTargets'; id: string; targets: readonly Target[] }
  | { type: 'bc/remove'; id: string }
  | { type: 'contacts/replace'; contacts: Contact[] }
  | { type: 'contacts/add'; contact: Contact }
  | { type: 'contacts/patch'; id: string; patch: ContactPatch }
  /** One edit across every patch of a joint; see `ui/state/contactGroups`. */
  | { type: 'contacts/patchMany'; ids: readonly string[]; patch: ContactPatch }
  | { type: 'contacts/remove'; id: string }
  | { type: 'cavities/replace'; cavities: Cavity[] }
  | { type: 'cavities/patch'; id: number; patch: CavityPatch }
  | { type: 'cavities/setCondition'; id: number; condition: CavityCondition };

const SCENARIO_NAMESPACES = ['scenario/', 'parts/', 'bc/', 'contacts/', 'cavities/'];

export function isScenarioAction(action: { type: string }): action is ScenarioAction {
  return SCENARIO_NAMESPACES.some((namespace) => action.type.startsWith(namespace));
}

export function scenarioReducer(state: Scenario, action: ScenarioAction): Scenario {
  switch (action.type) {
    case 'scenario/replace':
      return action.scenario;

    case 'scenario/setAmbient':
      return state.ambient === action.ambient ? state : { ...state, ambient: action.ambient };

    case 'scenario/setGravity':
      return { ...state, gravity: action.gravity };

    case 'scenario/setSolver': {
      const solver = { ...state.solver, ...action.patch };
      return isSamePlainObject(state.solver, solver) ? state : { ...state, solver };
    }

    case 'scenario/setColorScale': {
      const colorScale = { ...state.colorScale, ...action.patch };
      return isSamePlainObject(state.colorScale, colorScale) ? state : { ...state, colorScale };
    }

    case 'parts/patchOverride': {
      if (action.partIds.length === 0) return state;
      const partOverrides = { ...state.partOverrides };
      let changed = false;
      for (const partId of action.partIds) {
        const merged = { ...partOverrides[partId], ...action.patch };
        if (isSamePlainObject(partOverrides[partId] ?? {}, merged)) continue;
        partOverrides[partId] = merged;
        changed = true;
      }
      return changed ? { ...state, partOverrides } : state;
    }

    case 'parts/clearOverride': {
      const partOverrides = { ...state.partOverrides };
      let changed = false;
      for (const partId of action.partIds) {
        if (!(partId in partOverrides)) continue;
        delete partOverrides[partId];
        changed = true;
      }
      return changed ? { ...state, partOverrides } : state;
    }

    case 'parts/isolate': {
      const kept = new Set(action.partIds);
      const partOverrides = { ...state.partOverrides };
      for (const partId of action.allPartIds) {
        partOverrides[partId] = { ...partOverrides[partId], visible: kept.has(partId) };
      }
      return { ...state, partOverrides };
    }

    case 'parts/showAll': {
      const partOverrides = { ...state.partOverrides };
      for (const partId of action.allPartIds) {
        partOverrides[partId] = { ...partOverrides[partId], visible: true };
      }
      return { ...state, partOverrides };
    }

    case 'bc/add': {
      const targets = dedupeTargets(action.condition.targets);
      // Same invariant as `bc/setTargets`: a condition that names nothing is meaningless.
      if (targets.length === 0) return state;
      return {
        ...state,
        boundaryConditions: [...state.boundaryConditions, { ...action.condition, targets }],
      };
    }

    case 'bc/patch': {
      let changed = false;
      const boundaryConditions = state.boundaryConditions.map((condition) => {
        if (condition.id !== action.id) return condition;
        const patched = patchBoundaryCondition(condition, action.patch);
        if (patched !== condition) changed = true;
        return patched;
      });
      return changed ? { ...state, boundaryConditions } : state;
    }

    case 'bc/setTargets': {
      const targets = dedupeTargets(action.targets);
      // The row's own delete button is how a condition goes away; emptying its member
      // set would leave one that names nothing.
      if (targets.length === 0) return state;
      let changed = false;
      const boundaryConditions = state.boundaryConditions.map((condition) => {
        if (condition.id !== action.id || sameTargets(condition.targets, targets)) return condition;
        changed = true;
        return { ...condition, targets };
      });
      return changed ? { ...state, boundaryConditions } : state;
    }

    case 'bc/remove': {
      const boundaryConditions = state.boundaryConditions.filter(
        (condition) => condition.id !== action.id,
      );
      return boundaryConditions.length === state.boundaryConditions.length
        ? state
        : { ...state, boundaryConditions };
    }

    case 'contacts/replace':
      return { ...state, contacts: action.contacts };

    case 'contacts/add':
      return { ...state, contacts: [...state.contacts, action.contact] };

    case 'contacts/patch':
      return patchContacts(state, (contact) => contact.id === action.id, action.patch);

    case 'contacts/patchMany': {
      const ids = new Set(action.ids);
      return patchContacts(state, (contact) => ids.has(contact.id), action.patch);
    }

    case 'contacts/remove': {
      const contacts = state.contacts.filter((contact) => contact.id !== action.id);
      return contacts.length === state.contacts.length ? state : { ...state, contacts };
    }

    case 'cavities/replace':
      return { ...state, cavities: action.cavities };

    case 'cavities/patch': {
      let changed = false;
      const cavities = state.cavities.map((cavity) => {
        if (cavity.id !== action.id) return cavity;
        const patched = { ...cavity, ...action.patch };
        if (isSamePlainObject(cavity, patched)) return cavity;
        changed = true;
        return patched;
      });
      return changed ? { ...state, cavities } : state;
    }

    case 'cavities/setCondition': {
      let changed = false;
      const cavities = state.cavities.map((cavity) => {
        if (cavity.id !== action.id || cavity.condition === action.condition) return cavity;
        changed = true;
        // The physics helper mutates; hand it a copy so the old cavity stays intact.
        return setCavityCondition({ ...cavity }, action.condition);
      });
      return changed ? { ...state, cavities } : state;
    }

    default:
      return state;
  }
}

function patchContacts(
  state: Scenario,
  selects: (contact: Contact) => boolean,
  patch: ContactPatch,
): Scenario {
  let changed = false;
  const contacts = state.contacts.map((contact) => {
    if (!selects(contact)) return contact;
    const patched = { ...contact, ...patch };
    if (patched.conductance === contact.conductance && patched.enabled === contact.enabled) {
      return contact;
    }
    changed = true;
    return patched;
  });
  return changed ? { ...state, contacts } : state;
}

/**
 * Applies only the field belonging to the condition's kind — a `watts` patch aimed
 * at a `fixedTemp` condition is a caller bug, not a silent unit conversion.
 */
export function patchBoundaryCondition(
  condition: BoundaryCondition,
  patch: BoundaryConditionPatch,
): BoundaryCondition {
  const enabled = patch.enabled ?? condition.enabled;
  switch (condition.kind) {
    case 'fixedTemp': {
      const value = patch.value ?? condition.value;
      if (value === condition.value && enabled === condition.enabled) return condition;
      return { ...condition, value, enabled };
    }
    case 'heatLoad': {
      const watts = patch.watts ?? condition.watts;
      if (watts === condition.watts && enabled === condition.enabled) return condition;
      return { ...condition, watts, enabled };
    }
    case 'convection': {
      const h = patch.h ?? condition.h;
      if (h === condition.h && enabled === condition.enabled) return condition;
      return { ...condition, h, enabled };
    }
    default:
      return condition;
  }
}

function isSamePlainObject(a: object, b: object): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  }
  return true;
}
