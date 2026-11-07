// COPIED from engine/src/rng.ts by spacetimedb/scripts/sync-engine.ts. Do not edit here; edit engine/src and re-sync.
// Seeded, dependency-free random number generator.
// The engine core never calls Math.random; anything that needs randomness
// (fixture generation, optional tie-breaking) receives an Rng explicitly so
// every run is reproducible.

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
}

/** FNV-1a 32-bit hash of a string, for deriving numeric seeds from ids. */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for synthetic data. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** Integer in [lo, hi] inclusive. */
export function randInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng.next() * (hi - lo + 1));
}

/** Standard normal via Box-Muller (one draw per call). */
export function randNormal(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng.next();
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function chance(rng: Rng, p: number): boolean {
  return rng.next() < p;
}
