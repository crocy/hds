/**
 * The theme choice itself: the three modes a user can pick, the two looks they
 * resolve to, and the storage key the choice is remembered under.
 *
 * Pure — no React, no DOM — so the resolution rule and the parsing of an untrusted
 * stored value are unit-testable in Node, like `physics/` and `analysis/`.
 *
 * The choice is remembered in `localStorage` and deliberately never in a project
 * file: theme is a property of the machine, not of the model under study, so a
 * `.hds.json` shared with a colleague must not drag the reader into your theme.
 */

/** `system` follows `prefers-color-scheme`; the other two override it. */
export type ThemeMode = 'system' | 'dark' | 'light';

/** What `system` collapses to once the OS preference is known. */
export type ResolvedTheme = 'dark' | 'light';

/** Also the order the segmented control renders in. */
export const THEME_MODES: readonly ThemeMode[] = ['system', 'dark', 'light'];

export const THEME_STORAGE_KEY = 'hds.theme';

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode;
}

function isThemeMode(raw: string): raw is ThemeMode {
  return (THEME_MODES as readonly string[]).includes(raw);
}

/**
 * A stored value is untrusted input — it survives a downgrade, a hand-edited
 * localStorage and a key another tool wrote — so anything that is not one of the
 * three modes reads as `system` rather than throwing.
 */
export function parseThemeMode(raw: string | null): ThemeMode {
  if (raw === null) return 'system';
  return isThemeMode(raw) ? raw : 'system';
}
