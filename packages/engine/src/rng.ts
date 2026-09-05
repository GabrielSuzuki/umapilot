/**
 * Seeded PRNG.
 *
 * The whole regression strategy depends on `Scenario.step` being a pure
 * function of (state, action, rng), so the generator must be explicit,
 * deterministic, and never reach for `Math.random`. Passing the rng in rather
 * than holding it in module state is what makes a career run reproducible from
 * a single seed.
 *
 * mulberry32: 32-bit state, fast, good enough for Monte Carlo rollouts. Not
 * cryptographic, and it does not need to be.
 */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, n). */
export function randInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

/** Pick one key from a weight map. Weights need not sum to 1. */
export function weightedPick<T extends string>(
  rng: Rng,
  weights: Record<T, number>,
): T {
  const keys = Object.keys(weights) as T[];
  let total = 0;
  for (const k of keys) total += weights[k];
  let r = rng() * total;
  for (const k of keys) {
    r -= weights[k];
    if (r <= 0) return k;
  }
  return keys[keys.length - 1]!;
}

/** True with probability p. */
export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}
