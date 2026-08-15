import { describe, expect, it } from 'vitest';
import { decodeAs, decodeBinaryArray, encodeBinaryArray } from './binary';
import { fnv1a64, hashBytes } from './hash';

describe('binary arrays', () => {
  it('round-trips every element type', () => {
    const arrays = [
      Uint8Array.of(0, 1, 255),
      Uint32Array.of(0, 7, 4294967295),
      Float32Array.of(-1.5, 0, 3.25),
      Float64Array.of(Math.PI, -0),
    ];
    for (const array of arrays) {
      const decoded = decodeBinaryArray(encodeBinaryArray(array), 'field');
      expect(decoded.constructor).toBe(array.constructor);
      expect([...decoded]).toEqual([...array]);
    }
  });

  it('round-trips an array long enough to need chunked encoding', () => {
    const array = new Float32Array(100_000);
    for (let i = 0; i < array.length; i++) array[i] = i * 0.5;
    const decoded = decodeAs(encodeBinaryArray(array), 'f32', 'big');
    expect(decoded.length).toBe(array.length);
    expect(decoded[99_999]).toBe(array[99_999]);
  });

  it('names the field when a value is truncated, mistyped or not an array at all', () => {
    const encoded = encodeBinaryArray(Uint32Array.of(1, 2, 3));
    expect(() => decodeBinaryArray({ ...encoded, length: 4 }, 'mesh.tris')).toThrow(
      /mesh\.tris: declared 4/,
    );
    expect(() => decodeAs(encoded, 'f32', 'mesh.nodes')).toThrow(/expected f32, got u32/);
    expect(() => decodeBinaryArray(null, 'mesh.nodes')).toThrow(/mesh\.nodes: expected/);
    expect(() => decodeBinaryArray({ dtype: 'u16', base64: '' }, 'x')).toThrow(/unknown element/);
  });
});

describe('hashBytes', () => {
  it('is stable and content-sensitive', async () => {
    const a = await hashBytes(Uint8Array.of(1, 2, 3));
    const b = await hashBytes(Uint8Array.of(1, 2, 3));
    const c = await hashBytes(Uint8Array.of(1, 2, 4));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^(sha256|fnv1a):/);
  });

  it('has a fallback that is also content-sensitive', () => {
    expect(fnv1a64(Uint8Array.of(1, 2, 3))).not.toBe(fnv1a64(Uint8Array.of(1, 2, 4)));
    expect(fnv1a64(Uint8Array.of(1))).toHaveLength(16);
  });
});
