/**
 * Browser file plumbing: reading what the user dropped in, writing what they save.
 * Kept apart from the project format so `project.ts` stays testable in Node.
 */

import { PROJECT_EXTENSION } from './project';

export function readFileBytes(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

export function readFileText(file: File): Promise<string> {
  return file.text();
}

export function downloadText(filename: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking synchronously can beat the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function isProjectFilename(name: string): boolean {
  return name.toLowerCase().endsWith(PROJECT_EXTENSION);
}

export function suggestProjectFilename(sourceName: string | null): string {
  const base = (sourceName ?? 'untitled').replace(/\.[^.]+$/, '');
  return `${base}${PROJECT_EXTENSION}`;
}
