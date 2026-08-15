/**
 * Main-thread half of the import worker.
 *
 * Falls back to running the pipeline in place if the Worker cannot be created or
 * dies while loading its module: a slow import is worse than a fast one, but both
 * beat an app that cannot open a file at all.
 */

import ImportWorker from './importWorker?worker';
import type { ImportProduct, ImportProgress, ImportSettings } from './importPipeline';
import type { ImportRequest, ImportResponse } from './importProtocol';

interface PendingImport {
  requestId: number;
  resolve(product: ImportProduct): void;
  reject(error: Error): void;
  onProgress: ImportProgress;
}

export class ImportRunner {
  private worker: Worker | null = null;
  private pending: PendingImport | null = null;
  private nextRequestId = 1;
  private useWorker = true;

  /** Rejects with a message fit to show the user; never resolves twice. */
  async run(
    filename: string,
    data: ArrayBuffer,
    settings: ImportSettings,
    onProgress: ImportProgress = () => {},
  ): Promise<ImportProduct> {
    if (this.pending) throw new Error('An import is already running');
    const worker = this.useWorker ? this.ensureWorker() : null;
    if (!worker) return this.runOnMainThread(filename, data, settings, onProgress);

    const requestId = this.nextRequestId++;
    return new Promise<ImportProduct>((resolve, reject) => {
      this.pending = { requestId, resolve, reject, onProgress };
      const request: ImportRequest = { requestId, filename, data, settings };
      worker.postMessage(request, [data]);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending = null;
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const worker = new ImportWorker();
      worker.onmessage = (event: MessageEvent<ImportResponse>) => this.handle(event.data);
      worker.onerror = (event) => this.failPending(event.message || 'The import worker crashed');
      worker.onmessageerror = () =>
        this.failPending('The import worker sent an unreadable message');
      this.worker = worker;
      return worker;
    } catch {
      this.useWorker = false;
      return null;
    }
  }

  private handle(response: ImportResponse): void {
    const pending = this.pending;
    if (!pending || pending.requestId !== response.requestId) return;
    switch (response.kind) {
      case 'progress':
        pending.onProgress(response.stage);
        return;
      case 'result':
        this.pending = null;
        pending.resolve(response.product);
        return;
      case 'error': {
        this.pending = null;
        const error = new Error(response.message);
        error.name = response.name;
        pending.reject(error);
        return;
      }
    }
  }

  private failPending(message: string): void {
    const pending = this.pending;
    // A worker that died mid-load will not recover; the next import runs in place.
    this.worker?.terminate();
    this.worker = null;
    this.useWorker = false;
    this.pending = null;
    pending?.reject(new Error(message));
  }

  private async runOnMainThread(
    filename: string,
    data: ArrayBuffer,
    settings: ImportSettings,
    onProgress: ImportProgress,
  ): Promise<ImportProduct> {
    const { runImportPipeline } = await import('./importPipeline');
    return runImportPipeline(filename, data, settings, onProgress);
  }
}
