import { describe, expect, it } from 'vitest';
import { parseThemeMode, resolveTheme, THEME_MODES, THEME_STORAGE_KEY } from './theme';

describe('resolveTheme', () => {
  it('follows the system preference only in system mode', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
  });
});

describe('parseThemeMode', () => {
  it('round-trips every mode the control can store', () => {
    expect(THEME_MODES).toEqual(['system', 'dark', 'light']);
    for (const mode of THEME_MODES) expect(parseThemeMode(mode)).toBe(mode);
  });

  it('falls back to system for anything it did not write', () => {
    expect(parseThemeMode(null)).toBe('system');
    expect(parseThemeMode('')).toBe('system');
    expect(parseThemeMode('Dark')).toBe('system');
    expect(parseThemeMode('{}')).toBe('system');
    expect(parseThemeMode('{"mode":"light"}')).toBe('system');
    expect(parseThemeMode('  dark  ')).toBe('system');
    expect(parseThemeMode('toString')).toBe('system');
    expect(parseThemeMode('nachtmodus')).toBe('system');
  });
});

describe('THEME_STORAGE_KEY', () => {
  it('is namespaced to the app, so it cannot collide on a shared origin', () => {
    expect(THEME_STORAGE_KEY).toBe('hds.theme');
  });
});
