/**
 * Content hash of the imported CAD file.
 *
 * A project file references its CAD file by name and hash, so reopening it against
 * a changed file can say "this is not the geometry the scenario was built on"
 * instead of silently binding boundary conditions to different faces.
 *
 * The algorithm is part of the stored value because `crypto.subtle` is unavailable
 * outside a secure context, and a hash whose provenance is ambiguous is worse than
 * no hash at all.
 */

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return `fnv1a:${fnv1a64(bytes)}`;
  const source = new Uint8Array(bytes);
  const digest = await subtle.digest('SHA-256', source);
  return `sha256:${toHex(new Uint8Array(digest))}`;
}

/**
 * Fallback fingerprint for insecure contexts: two 32-bit FNV-1a passes with
 * different constants, concatenated. Not a cryptographic hash — it only has to
 * notice that the CAD file changed.
 */
export function fnv1a64(bytes: Uint8Array): string {
  return (
    toHex32(fnv1a32(bytes, 0x811c9dc5, 0x01000193)) +
    toHex32(fnv1a32(bytes, 0x9e3779b9, 0x85ebca6b))
  );
}

function fnv1a32(bytes: Uint8Array, seed: number, prime: number): number {
  let hash = seed;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, prime);
  }
  return hash >>> 0;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function toHex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}
