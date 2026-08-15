/**
 * The message contract between the UI and the solve worker.
 *
 * Separate from `worker.ts` because that file touches `self` at import time and so
 * cannot be loaded in Node; this one is plain data and is unit-testable.
 *
 * Every request is answered exactly once, with a `result` or an `error`. A worker
 * that throws and posts nothing leaves the UI waiting forever, which is the failure
 * this envelope exists to prevent.
 */

import type { Material, Scenario, SolveResult, SurfaceFinish, ThermalModel } from '../core/types';

export interface SolveRequest {
  /** Echoed back on the response, so a late reply from a superseded run is ignorable. */
  requestId: number;
  model: ThermalModel;
  scenario: Scenario;
  /** Previous field, for warm starting. */
  previous?: Float32Array;
  /** Custom materials the scenario refers to by id; the worker has its own registry. */
  materials?: Material[];
  finishes?: SurfaceFinish[];
}

export interface SolveResultResponse {
  kind: 'result';
  requestId: number;
  result: SolveResult;
}

export interface SolveErrorResponse {
  kind: 'error';
  requestId: number;
  /** Already human-readable: this is what the UI shows. */
  message: string;
  name: string;
  stack?: string;
}

export type SolveResponse = SolveResultResponse | SolveErrorResponse;

/** Normalises anything `throw`n — including non-Errors — into the error envelope. */
export function toSolveErrorResponse(requestId: number, error: unknown): SolveErrorResponse {
  if (error instanceof Error) {
    return {
      kind: 'error',
      requestId,
      name: error.name,
      message: error.message || String(error),
      stack: error.stack,
    };
  }
  return {
    kind: 'error',
    requestId,
    name: 'Error',
    message:
      typeof error === 'string' && error.length > 0 ? error : `Solver threw ${String(error)}`,
  };
}
