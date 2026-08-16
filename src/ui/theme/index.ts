/**
 * The theme's public surface. Consumers import from `@/ui/theme`, so the split
 * between the pure resolution rule, the contrast maths and the React binding stays
 * an implementation detail.
 */

export { parseThemeMode, resolveTheme, THEME_MODES, THEME_STORAGE_KEY } from './theme';
export type { ResolvedTheme, ThemeMode } from './theme';

export { ThemeProvider, useTheme } from './ThemeProvider';
export type { ThemeContextValue } from './ThemeProvider';

export { contrastRatio, hexFromNumber, parseHexColor, relativeLuminance } from './contrast';
export type { RGB } from './contrast';
