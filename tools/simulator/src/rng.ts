// Deterministic PRNG (mulberry32). Every simulator decision flows through one
// of these helpers so a fixed seed replays the exact same practice activity —
// CI can assert exact outcomes, demos can be re-run identically.

export interface Rng {
  /** Uniform float in [0, 1). */
  float(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniform pick from a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Weighted pick: [item, weight][] with positive weights. */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T;
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const float = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(float() * (max - min + 1));
  return {
    float,
    int,
    chance: (p) => float() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error("pick from empty array");
      return items[int(0, items.length - 1)];
    },
    weighted: (entries) => {
      const total = entries.reduce((sum, [, w]) => sum + w, 0);
      let roll = float() * total;
      for (const [item, w] of entries) {
        roll -= w;
        if (roll <= 0) return item;
      }
      return entries[entries.length - 1][0];
    }
  };
}
