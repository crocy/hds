/**
 * Web Worker shell around `solveShell`.
 *
 * Deliberately empty of physics: everything real lives in solve.ts so it stays
 * testable in Node, where there is no Worker. The message contract lives in
 * `workerProtocol.ts` for the same reason.
 *
 * Every request is answered: a solve that throws posts an error envelope rather
 * than leaving the awaiting UI hanging.
 */

import { registerFinish, registerMaterial } from './materials';
import { solveShell } from './solve';
import {
  toSolveErrorResponse,
  type SolveRequest,
  type SolveResultResponse,
} from './workerProtocol';

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<SolveRequest>) => {
  const { requestId, model, scenario, previous, materials, finishes } = event.data;
  try {
    for (const material of materials ?? []) registerMaterial(material);
    for (const finish of finishes ?? []) registerFinish(finish);
    const response: SolveResultResponse = {
      kind: 'result',
      requestId,
      result: solveShell(model, scenario, previous),
    };
    worker.postMessage(response, [response.result.temperature.buffer]);
  } catch (error) {
    worker.postMessage(toSolveErrorResponse(requestId, error));
  }
};
