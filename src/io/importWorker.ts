/**
 * Worker shell around `runImportPipeline`.
 *
 * Tessellation, welding and the two ray-cast detections are seconds of straight-line
 * CPU; on the main thread they would freeze the view and the progress overlay along
 * with it.
 */

import { runImportPipeline } from './importPipeline';
import { toImportErrorResponse, type ImportRequest, type ImportResponse } from './importProtocol';

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = async (event: MessageEvent<ImportRequest>) => {
  const { requestId, filename, data, settings } = event.data;
  const post = (response: ImportResponse) => worker.postMessage(response);
  try {
    const product = await runImportPipeline(filename, data, settings, (stage) =>
      post({ kind: 'progress', requestId, stage }),
    );
    post({ kind: 'result', requestId, product });
  } catch (error) {
    post(toImportErrorResponse(requestId, error));
  }
};
