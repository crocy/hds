/**
 * React binding for the theme: the mode the user picked, the look it resolves to,
 * and the setter that remembers it.
 *
 * CSS reads the resolved theme off `<html data-theme>`, which this writes. The
 * viewer and the plots read it through the context instead, because neither three.js
 * nor a canvas pixel buffer can use a CSS custom property.
 *
 * Both `localStorage` accesses are wrapped: a browser with storage disabled throws
 * on the property rather than returning null, and losing the theme across reloads is
 * a better failure than a shell that will not mount.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  parseThemeMode,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemeMode,
} from './theme';

export interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Null where `matchMedia` is missing — jsdom, a worker, an older browser. */
const darkSchemeQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

function subscribeToSystemScheme(onChange: () => void): () => void {
  darkSchemeQuery?.addEventListener('change', onChange);
  return () => darkSchemeQuery?.removeEventListener('change', onChange);
}

/** Dark when the preference cannot be read: it is what the app looked like before themes. */
function getSystemPrefersDark(): boolean {
  return darkSchemeQuery?.matches ?? true;
}

function readStoredMode(): ThemeMode {
  try {
    return parseThemeMode(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

function storeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Storage is unavailable; the theme still applies, it just will not survive a reload.
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setStoredMode] = useState(readStoredMode);
  // Subscribed rather than read once, so changing the OS setting moves a `system`
  // user live instead of waiting for a reload.
  const systemPrefersDark = useSyncExternalStore(
    subscribeToSystemScheme,
    getSystemPrefersDark,
    getSystemPrefersDark,
  );
  const resolved = resolveTheme(mode, systemPrefersDark);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    setStoredMode(next);
    storeMode(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('useTheme must be used inside <ThemeProvider>');
  return theme;
}
