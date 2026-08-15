/**
 * The hover readout, kept out of the reducer on purpose.
 *
 * `onHover` fires once per animation frame while the pointer moves. Routing that
 * through the app state would re-render every panel 60 times a second; this store
 * re-renders only the readout that subscribes to it.
 */

import { useSyncExternalStore } from 'react';
import type { HoverEvent } from '@/viewer';

export interface HoverStore {
  subscribe(listener: () => void): () => void;
  get(): HoverEvent | null;
  set(hover: HoverEvent | null): void;
}

export function createHoverStore(): HoverStore {
  let current: HoverEvent | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get() {
      return current;
    },
    set(hover) {
      if (current === null && hover === null) return;
      current = hover;
      for (const listener of listeners) listener();
    },
  };
}

export function useHover(store: HoverStore): HoverEvent | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
