/**
 * The plots' public surface. The app imports from `@/ui/plots` and never reaches
 * into the individual modules, so the split between the components, the scale
 * maths and the rasterisers stays an implementation detail.
 *
 * Every component here is pure and presentational: it takes already-computed
 * analysis output plus display options, and neither reads the store nor computes
 * physics. Temperatures arrive in kelvin and are displayed in °C.
 */

export { PathLengthPlot } from './PathLengthPlot';
export type { PathLengthAnnotation, PathLengthPlotProps, ReferenceDecay } from './PathLengthPlot';

export { SectionFieldPlot } from './SectionFieldPlot';
export type { SectionFieldPlotProps } from './SectionFieldPlot';

export { SectionProfilePlot } from './SectionProfilePlot';
export type { ProfileSpan, SectionProfilePlotProps } from './SectionProfilePlot';

export { ThresholdPlot } from './ThresholdPlot';
export type { ThresholdPlotProps } from './ThresholdPlot';

export { HeatBalanceView } from './HeatBalanceView';
export type { HeatBalanceViewProps } from './HeatBalanceView';
