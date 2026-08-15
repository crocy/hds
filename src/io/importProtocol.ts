/**
 * The message contract between the UI and the import worker.
 *
 * Same shape as the solve protocol, and for the same reason: an import that throws
 * inside the worker must come back as an error the user can read, not as silence.
 */

import type { ImportProduct, ImportSettings, ImportStage } from './importPipeline';

export interface ImportRequest {
  requestId: number;
  filename: string;
  /** Transferred, so the file bytes are not copied into the worker. */
  data: ArrayBuffer;
  settings: ImportSettings;
}

export interface ImportProgressResponse {
  kind: 'progress';
  requestId: number;
  stage: ImportStage;
}

export interface ImportResultResponse {
  kind: 'result';
  requestId: number;
  product: ImportProduct;
}

export interface ImportErrorResponse {
  kind: 'error';
  requestId: number;
  message: string;
  name: string;
  stack?: string;
}

export type ImportResponse = ImportProgressResponse | ImportResultResponse | ImportErrorResponse;

export function toImportErrorResponse(requestId: number, error: unknown): ImportErrorResponse {
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
      typeof error === 'string' && error.length > 0 ? error : `Import threw ${String(error)}`,
  };
}
