/**
 * Typed arrays in and out of JSON.
 *
 * A project file carries node positions and triangle indices — hundreds of
 * thousands of numbers. As a JSON array of decimals that is roughly 10× the bytes
 * and lossy for float32, so each array travels as base64 of its own memory plus the
 * element type it must be read back as.
 */

export type BinaryDtype = 'u8' | 'u32' | 'f32' | 'f64';

export interface BinaryArray {
  dtype: BinaryDtype;
  /** Element count, checked on decode so a truncated file fails loudly. */
  length: number;
  base64: string;
}

type TypedArray = Uint8Array | Uint32Array | Float32Array | Float64Array;

const CONSTRUCTORS = {
  u8: Uint8Array,
  u32: Uint32Array,
  f32: Float32Array,
  f64: Float64Array,
} as const;

export function dtypeOf(array: TypedArray): BinaryDtype {
  if (array instanceof Uint8Array) return 'u8';
  if (array instanceof Uint32Array) return 'u32';
  if (array instanceof Float32Array) return 'f32';
  if (array instanceof Float64Array) return 'f64';
  throw new Error('unsupported typed array');
}

export function encodeBinaryArray(array: TypedArray): BinaryArray {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  return { dtype: dtypeOf(array), length: array.length, base64: bytesToBase64(bytes) };
}

/** `field` is only used to name the offender in the error message. */
export function decodeBinaryArray(value: unknown, field: string): TypedArray {
  const record = value as Partial<BinaryArray> | undefined;
  if (!record || typeof record.base64 !== 'string' || typeof record.dtype !== 'string') {
    throw new Error(`${field}: expected an encoded array, got ${describe(value)}`);
  }
  const constructor = CONSTRUCTORS[record.dtype as BinaryDtype];
  if (!constructor) throw new Error(`${field}: unknown element type '${record.dtype}'`);

  const bytes = base64ToBytes(record.base64, field);
  if (bytes.byteLength % constructor.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`${field}: ${bytes.byteLength} bytes is not a whole number of ${record.dtype}`);
  }
  const array = new constructor(
    bytes.buffer as ArrayBuffer,
    0,
    bytes.byteLength / constructor.BYTES_PER_ELEMENT,
  );
  if (typeof record.length === 'number' && record.length !== array.length) {
    throw new Error(`${field}: declared ${record.length} elements but carries ${array.length}`);
  }
  return array;
}

export function decodeAs<T extends BinaryDtype>(
  value: unknown,
  dtype: T,
  field: string,
): InstanceType<(typeof CONSTRUCTORS)[T]> {
  const array = decodeBinaryArray(value, field);
  if (dtypeOf(array) !== dtype) {
    throw new Error(`${field}: expected ${dtype}, got ${dtypeOf(array)}`);
  }
  return array as InstanceType<(typeof CONSTRUCTORS)[T]>;
}

/** Chunked, because `fromCharCode` on a megabyte-long spread overflows the stack. */
const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string, field = 'value'): Uint8Array {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error(`${field}: not valid base64`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}
