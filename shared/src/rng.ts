// Deterministic hashing — the entire world derives from these.
// Both server and client import this file; any change desyncs the universe.

export function hash2(seed: number, x: number, z: number, salt = 0): number {
  let h = (seed | 0) ^ Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(salt | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}

export const rand01 = (h: number): number => h / 4294967296;

export const r2 = (seed: number, x: number, z: number, salt = 0): number =>
  rand01(hash2(seed, x, z, salt));

/** FNV-1a string hash — turns a room code into a world seed. */
export function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small seeded PRNG for sequences (props, decor). */
export function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
