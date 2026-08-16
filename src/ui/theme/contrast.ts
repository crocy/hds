/**
 * WCAG 2.1 contrast, for the tests that keep a theme's background from swallowing
 * an end of the colormap.
 *
 * Pure, and shared by the plot and viewer palettes so both measure a colour against
 * their own ground the same way. Colours arrive as the colormap's sRGB 0..1 triple,
 * so a sampled ramp colour can be fed in directly; the hex and three.js-number
 * helpers exist because the palettes are written in the form each consumer needs.
 */

import { srgbToLinear, type RGB } from '@/viewer/colormap';

export type { RGB };

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Accepts `#rgb` and `#rrggbb`. Throws on anything else: the input is a hand-written constant. */
export function parseHexColor(hex: string): RGB {
  const match = HEX_PATTERN.exec(hex.trim());
  if (!match) throw new Error(`'${hex}' is not a #rgb or #rrggbb colour`);
  const digits = match[1];
  const pairs = digits.length === 3 ? digits.replace(/./g, (digit) => digit + digit) : digits;
  return [
    parseInt(pairs.slice(0, 2), 16) / 255,
    parseInt(pairs.slice(2, 4), 16) / 255,
    parseInt(pairs.slice(4, 6), 16) / 255,
  ];
}

/** `0xRRGGBB`, the form three.js takes, as `#rrggbb`. */
export function hexFromNumber(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * WCAG 2.1 relative luminance. Linearised with `srgbToLinear`, which puts the knee
 * at IEC's 0.04045 rather than the 0.03928 WCAG prints — a difference below 1e-5 in
 * the result, and worth the reuse.
 */
export function relativeLuminance([r, g, b]: RGB): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 2.1 contrast ratio, 1 (identical) to 21 (black on white). Order does not matter. */
export function contrastRatio(a: RGB, b: RGB): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}
