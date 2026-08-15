/**
 * Main-thread half of the solve worker.
 *
 * The solver never runs on the main thread: a Picard loop over a few thousand nodes
 * is hundreds of milliseconds at best, and the view has to stay live while it runs.
 *
 * Every request is answered — by the worker's error envelope, by `onerror` when the
 * worker itself dies, or by the reject below when a newer solve supersedes it — so
 * the UI can never be left showing a spinner forever.
 */

import type { Material, Scenario, SolveResult, SurfaceFinish, ThermalModel } from '@/core/types';
import SolveWorker from '@/physics/worker?worker';
import type { SolveRequest, SolveResponse } from '@/physics/workerProtocol';

/** The one rejection the UI ignores rather than showing: a newer run is already in flight. */
export const SUPERSEDED_SOLVE = 'SupersededSolve';

function supersededError(): Error {
  const error = new Error('Superseded by a newer solve');
  error.name = SUPERSEDED_SOLVE;
  return error;
}

export interface SolveInput {
  model: ThermalModel;
  scenario: Scenario;
  /** Previous field, for warm starting. Copied, so the caller keeps its array. */
  previous?: Float32Array | null;
  materials?: Material[];
  finishes?: SurfaceFinish[];
}

interface PendingSolve {
  requestId: number;
  resolve(result: SolveResult): void;
  reject(error: Error): void;
}

export class SolveRunner {
  private worker: Worker | null = null;
  private pending: PendingSolve | null = null;
  private nextRequestId = 1;

  solve(input: SolveInput): Promise<SolveResult> {
    const worker = this.ensureWorker();
    const requestId = this.nextRequestId++;
    // A superseded run's answer would overwrite a newer field, so it is dropped here
    // rather than raced downstream.
    this.pending?.reject(supersededError());
    this.pending = null;

    return new Promise<SolveResult>((resolve, reject) => {
      this.pending = { requestId, resolve, reject };
      const request: SolveRequest = {
        requestId,
        model: input.model,
        scenario: input.scenario,
        materials: input.materials,
        finishes: input.finishes,
      };
      // Structured clone copies `previous`, so warm starting never steals the
      // field the viewer is currently drawing.
      if (input.previous) request.previous = input.previous;
      worker.postMessage(request);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending?.reject(new Error('The solver was shut down'));
    this.pending = null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new SolveWorker();
    worker.onmessage = (event: MessageEvent<SolveResponse>) => this.handle(event.data);
    worker.onerror = (event) =>
      this.failPending(event.message || 'The solve worker crashed before it could answer');
    worker.onmessageerror = () => this.failPending('The solve worker sent an unreadable message');
    this.worker = worker;
    return worker;
  }

  private handle(response: SolveResponse): void {
    const pending = this.pending;
    if (!pending || pending.requestId !== response.requestId) return;
    this.pending = null;
    if (response.kind === 'result') {
      pending.resolve(response.result);
      return;
    }
    const error = new Error(response.message);
    error.name = response.name;
    if (response.stack) error.stack = response.stack;
    pending.reject(error);
  }

  private failPending(message: string): void {
    const pending = this.pending;
    this.worker?.terminate();
    this.worker = null;
    this.pending = null;
    pending?.reject(new Error(message));
  }
}
