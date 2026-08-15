/**
 * Web Worker shell around `solveShell`.
 *
 * Deliberately empty of physics: everything real lives in solve.ts so it stays
 * testable in Node, where there is no Worker.
 */

import type { Scenario, SolveResult, ThermalModel } from '../core/types';
import { solveShell } from './solve';

export interface SolveRequest {
  model: ThermalModel;
  scenario: Scenario;
  previous?: Float32Array;
}

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<SolveRequest>) => {
  const { model, scenario, previous } = event.data;
  const result: SolveResult = solveShell(model, scenario, previous);
  worker.postMessage(result, [result.temperature.buffer]);
};
