/**
 * React binding for `projectReducer`.
 *
 * State and dispatch are separate contexts so a component that only dispatches does
 * not re-render when the state changes.
 */

import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';
import {
  createInitialState,
  projectReducer,
  type ProjectAction,
  type ProjectState,
} from './projectReducer';

const StateContext = createContext<ProjectState | null>(null);
const DispatchContext = createContext<Dispatch<ProjectAction> | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(projectReducer, undefined, createInitialState);
  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useProject(): ProjectState {
  const state = useContext(StateContext);
  if (!state) throw new Error('useProject must be used inside <ProjectProvider>');
  return state;
}

export function useDispatch(): Dispatch<ProjectAction> {
  const dispatch = useContext(DispatchContext);
  if (!dispatch) throw new Error('useDispatch must be used inside <ProjectProvider>');
  return dispatch;
}
