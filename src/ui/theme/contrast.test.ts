import { describe, expect, it } from 'vitest';
import { sample } from '@/viewer/colormap';
import {
  contrastRatio,
  hexFromNumber,
  parseHexColor,
  relativeLuminance,
  type RGB,
} from './contrast';

const BLACK = parseHexColor('#000');
const WHITE = parseHexColor('#ffffff');

/** The two viewport backgrounds the design chooses between. */
const DARK_VIEWPORT_BG = parseHexColor('#0c0c10');
const LIGHT_VIEWPORT_BG = parseHexColor('#b9bdc6');

const INFERNO_COLD = sample('inferno', 0);
const INFERNO_HOT = sample('inferno', 1);

/** The worse of the two ends — the one that decides whether a background loses part of the ramp. */
function weakestRampContrast(background: RGB): number {
  return Math.min(contrastRatio(background, INFERNO_COLD), contrastRatio(background, INFERNO_HOT));
}

function cssHex([r, g, b]: RGB): string {
  return `#${[r, g, b]
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

describe('parseHexColor', () => {
  it('reads #rgb as the expanded #rrggbb', () => {
    expect(parseHexColor('#b9c')).toEqual(parseHexColor('#bb99cc'));
    expect(parseHexColor('#FFF')).toEqual([1, 1, 1]);
  });

  it('returns sRGB 0..1, matching the colormap convention', () => {
    expect(parseHexColor('#000004')).toEqual([0, 0, 4 / 255]);
    expect(parseHexColor('#b9bdc6')).toEqual([0xb9 / 255, 0xbd / 255, 0xc6 / 255]);
  });

  it('throws rather than guess at anything that is not a hex colour', () => {
    expect(() => parseHexColor('rgba(20, 20, 26, 0.82)')).toThrow();
    expect(() => parseHexColor('#gggggg')).toThrow();
    expect(() => parseHexColor('#12345')).toThrow();
    expect(() => parseHexColor('')).toThrow();
  });
});

describe('hexFromNumber', () => {
  it('pads a three.js colour number to six digits', () => {
    expect(hexFromNumber(0x0c0c10)).toBe('#0c0c10');
    expect(hexFromNumber(0x000004)).toBe('#000004');
    expect(hexFromNumber(0xffffff)).toBe('#ffffff');
    expect(parseHexColor(hexFromNumber(0xb9bdc6))).toEqual(LIGHT_VIEWPORT_BG);
  });
});

describe('relativeLuminance', () => {
  it('spans 0 at black to 1 at white', () => {
    expect(relativeLuminance(BLACK)).toBe(0);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 12);
  });
});

describe('contrastRatio', () => {
  it('is 21 for white on black', () => {
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 12);
  });

  it('is 1 for a colour against itself', () => {
    for (const color of [BLACK, WHITE, LIGHT_VIEWPORT_BG, INFERNO_COLD, INFERNO_HOT]) {
      expect(contrastRatio(color, color)).toBeCloseTo(1, 12);
    }
  });

  it('is symmetric', () => {
    expect(contrastRatio(LIGHT_VIEWPORT_BG, INFERNO_HOT)).toBe(
      contrastRatio(INFERNO_HOT, LIGHT_VIEWPORT_BG),
    );
    expect(contrastRatio(BLACK, INFERNO_COLD)).toBe(contrastRatio(INFERNO_COLD, BLACK));
  });
});

describe('the light viewport background', () => {
  it('is measured against the ramp the app actually ships', () => {
    expect(cssHex(INFERNO_COLD)).toBe(hexFromNumber(0x000004));
    expect(cssHex(INFERNO_HOT)).toBe(hexFromNumber(0xfcffa4));
  });

  it("clears inferno's cold end, which near-black cannot", () => {
    expect(contrastRatio(LIGHT_VIEWPORT_BG, INFERNO_COLD)).toBeGreaterThan(3);
    expect(contrastRatio(DARK_VIEWPORT_BG, INFERNO_COLD)).toBeLessThan(1.1);
  });

  /**
   * Section 1's argument, pinned: whichever pole a background sits at, that end of
   * the ramp collapses into it, and a mid-grey loses less than either extreme. The
   * margin is real but thin — `#b9bdc6` holds inferno's hot end at only 1.79, short
   * of the 3.0 floor section 6 asks for, which needs a background near `#8d9098`.
   */
  it('loses less of the ramp than either near-black or white would', () => {
    expect(weakestRampContrast(LIGHT_VIEWPORT_BG)).toBeCloseTo(1.79, 2);
    expect(weakestRampContrast(LIGHT_VIEWPORT_BG)).toBeGreaterThan(
      weakestRampContrast(DARK_VIEWPORT_BG),
    );
    expect(weakestRampContrast(LIGHT_VIEWPORT_BG)).toBeGreaterThan(weakestRampContrast(WHITE));
    expect(weakestRampContrast(parseHexColor('#8d9098'))).toBeGreaterThanOrEqual(3);
  });
});
