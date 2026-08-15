/**
 * Mounts a `ThermalScene` on a div and hands it back once it is live.
 *
 * The scene is created inside the effect and disposed by its cleanup, so React 19's
 * double-invoked effects in development build and tear down a whole instance rather
 * than leaving a half-mounted one behind. Callers get `null` until it is ready and
 * key their own effects on that.
 */

import { useEffect, useRef, useState } from 'react';
import { ThermalScene, type ThermalSceneHandlers } from '@/viewer';

export interface MountedScene {
  containerRef: React.RefObject<HTMLDivElement | null>;
  scene: ThermalScene | null;
}

export function useThermalScene(handlers: ThermalSceneHandlers): MountedScene {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handlersRef = useRef(handlers);
  const [scene, setScene] = useState<ThermalScene | null>(null);

  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Trampolines, so changing a handler never re-creates the WebGL context.
    const instance = new ThermalScene({
      handlers: {
        onHover: (hover) => handlersRef.current.onHover?.(hover),
        onSelectionChange: (selection, hit) =>
          handlersRef.current.onSelectionChange?.(selection, hit),
        onSectionPlaneChange: (plane) => handlersRef.current.onSectionPlaneChange?.(plane),
        onCameraChange: (view) => handlersRef.current.onCameraChange?.(view),
      },
    });
    instance.mount(container);
    setScene(instance);
    return () => {
      setScene(null);
      instance.dispose();
    };
  }, []);

  return { containerRef, scene };
}
