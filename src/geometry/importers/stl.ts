/**
 * STL, binary and ASCII, hand-parsed.
 *
 * STL carries no assembly structure and no units. Parts are recovered from
 * connected components after welding (see `build.ts`), and the unit is a
 * caller-supplied assumption, defaulting to millimetres like every CAD exporter.
 */

import type { LengthUnit } from '../../core/units';
import type { ImportedMesh } from './index';

const BINARY_HEADER_BYTES = 80;
const BINARY_TRIANGLE_BYTES = 50;

export interface StlImportOptions {
  units?: LengthUnit;
  /** Base name for the derived parts. ASCII files override it with their solid name. */
  name?: string;
}

export function importStl(
  data: ArrayBuffer | Uint8Array,
  options: StlImportOptions = {},
): ImportedMesh {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const parsed = isBinaryStl(bytes) ? parseBinaryStl(bytes) : parseAsciiStl(bytes);

  const triCount = parsed.positions.length / 9;
  const indices = new Uint32Array(triCount * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;

  return {
    positions: Float64Array.from(parsed.positions),
    indices,
    triPart: new Uint32Array(triCount),
    triFace: null,
    partNames: [options.name ?? parsed.name ?? 'part 1'],
    units: options.units ?? 'mm',
    derivePartsFromComponents: true,
  };
}

/**
 * Binary STL has a fixed record size, so the length is a reliable discriminator.
 * Sniffing "solid" is not: binary exporters routinely write it in the 80-byte header.
 */
export function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < BINARY_HEADER_BYTES + 4) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredTriangles = view.getUint32(BINARY_HEADER_BYTES, true);
  if (BINARY_HEADER_BYTES + 4 + declaredTriangles * BINARY_TRIANGLE_BYTES === bytes.length) {
    return true;
  }
  const head = latin1(bytes.subarray(0, Math.min(bytes.length, 512)));
  return !(/^\s*solid/i.test(head) && /facet\s+normal/i.test(head));
}

interface ParsedStl {
  /** Flat xyz triples, three per triangle. */
  positions: number[];
  name: string | null;
}

function parseBinaryStl(bytes: Uint8Array): ParsedStl {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triCount = view.getUint32(BINARY_HEADER_BYTES, true);
  const available = Math.floor((bytes.length - BINARY_HEADER_BYTES - 4) / BINARY_TRIANGLE_BYTES);
  if (triCount > available) {
    throw new Error(`Binary STL declares ${triCount} triangles but holds ${available}`);
  }

  const positions: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const base = BINARY_HEADER_BYTES + 4 + t * BINARY_TRIANGLE_BYTES;
    const normal: [number, number, number] = [
      view.getFloat32(base, true),
      view.getFloat32(base + 4, true),
      view.getFloat32(base + 8, true),
    ];
    const corners: number[] = [];
    for (let c = 0; c < 9; c++) corners.push(view.getFloat32(base + 12 + c * 4, true));
    pushTriangle(positions, corners, normal);
  }
  return { positions, name: null };
}

function parseAsciiStl(bytes: Uint8Array): ParsedStl {
  const text = new TextDecoder().decode(bytes);
  const positions: number[] = [];
  let name: string | null = null;
  let normal: [number, number, number] = [0, 0, 0];
  let corners: number[] = [];

  for (const rawLine of text.split('\n')) {
    const tokens = rawLine.trim().split(/\s+/);
    const keyword = tokens[0].toLowerCase();
    if (keyword === 'solid') {
      name ??= tokens.slice(1).join(' ') || null;
    } else if (keyword === 'facet' && tokens[1]?.toLowerCase() === 'normal') {
      normal = [Number(tokens[2]), Number(tokens[3]), Number(tokens[4])];
      corners = [];
    } else if (keyword === 'vertex') {
      corners.push(Number(tokens[1]), Number(tokens[2]), Number(tokens[3]));
      if (corners.length === 9) {
        pushTriangle(positions, corners, normal);
        corners = [];
      }
    }
  }
  return { positions, name };
}

/**
 * Winding, not the stored normal, decides the outward direction downstream, so a
 * triangle whose winding contradicts a usable stored normal is reversed here.
 * Cavity detection and the convection correlations both depend on getting this right.
 */
function pushTriangle(positions: number[], corners: number[], normal: [number, number, number]) {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = corners;
  const wound = cross(bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az);
  const stated = Math.hypot(normal[0], normal[1], normal[2]);
  const flip =
    stated > 0.5 && wound[0] * normal[0] + wound[1] * normal[1] + wound[2] * normal[2] < 0;
  if (flip) positions.push(ax, ay, az, cx, cy, cz, bx, by, bz);
  else positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
}

function cross(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): [number, number, number] {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}
