/**
 * The plot palette for the theme in force.
 *
 * A hook rather than a `useTheme().resolved` → `plotPalette` step repeated in six
 * components, so every panel switches on the same value at the same time. The
 * palette it returns is one shared object per theme, so passing it straight into a
 * `useMemo`/`useCallback` dependency list re-runs a paint exactly on a theme change
 * and never on a re-render.
 */

import { useTheme } from '@/ui/theme';
import { plotPalette, type PlotPalette } from './theme';

export function usePlotPalette(): PlotPalette {
  return plotPalette(useTheme().resolved);
}
