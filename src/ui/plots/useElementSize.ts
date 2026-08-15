/**
 * Container-driven sizing. Every plot lays itself out from the box it was given
 * rather than from a fixed pixel size, so the panels reflow with the app shell.
 */

import { useEffect, useState, type RefObject } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

const ZERO_SIZE: ElementSize = { width: 0, height: 0 };

/**
 * Width and height of `ref`'s element in CSS pixels, `{0, 0}` until first measured.
 * The observer's initial callback supplies the first size, so nothing is measured
 * during render.
 */
export function useElementSize<T extends HTMLElement>(ref: RefObject<T | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>(ZERO_SIZE);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.contentRect;
      // Sub-pixel churn would re-run every canvas paint for no visible gain.
      setSize((previous) =>
        Math.abs(previous.width - box.width) < 0.5 && Math.abs(previous.height - box.height) < 0.5
          ? previous
          : { width: box.width, height: box.height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
