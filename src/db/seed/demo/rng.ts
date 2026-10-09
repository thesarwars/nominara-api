// STORY-169 — a deterministic PRNG, seeded by a project's own id, so
// re-running `pnpm db:seed-demo` against the same workspace produces the
// SAME data. `--purge` then followed by a re-seed is a no-op on the numbers,
// which is what "re-runs are stable" and "a re-run is idempotent" both need:
// a fresh Math.random() run would double every cell count instead of
// replacing it, and a diff between two runs would be unreadable noise.
//
// mulberry32 — small, dependency-free (KAD-13's purity rule applies to the
// scoring library specifically, but "no new dependency" is a hard boundary
// everywhere, and this is exactly the kind of thing an npm package exists
// for that a dozen lines does not need).

/** A 32-bit unsigned integer hash of a string, FNV-1a. Good enough for a seed — not cryptographic, never used as one. */
export function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export type Rng = () => number;

/** mulberry32: a tiny, deterministic PRNG. Returns a function yielding floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The PRNG for one project's demo data, seeded from its id (plus an optional namespace, so two generators drawn from the same project don't correlate). */
export function rngFor(projectId: string, namespace = ""): Rng {
  return mulberry32(fnv1a(`${projectId}:${namespace}`));
}

/** A float in `[min, max)`. */
export function uniform(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** An integer in `[min, max]`, inclusive both ends. */
export function uniformInt(rng: Rng, min: number, max: number): number {
  return Math.floor(uniform(rng, min, max + 1));
}

/** True with probability `p`. */
export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

/** One element of `items`, chosen deterministically by `rng`. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[uniformInt(rng, 0, items.length - 1)]!;
}
