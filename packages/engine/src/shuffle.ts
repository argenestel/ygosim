import { randomBytes } from "node:crypto";

type Seed = [bigint, bigint, bigint, bigint];
const range = 1n << 64n;
const mask = range - 1n;

/** Preserve the core's SplitMix64 seed expansion; use OS entropy when omitted. */
export function seeds(seed?: number): Seed {
  if (seed === undefined) {
    const bytes = randomBytes(32);
    return [0, 8, 16, 24].map(i => bytes.readBigUInt64LE(i)) as Seed;
  }
  let x = BigInt(seed);
  return [0, 1, 2, 3].map(() => {
    x = (x + 0x9e3779b97f4a7c15n) & mask;
    let z = x;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask;
    return z ^ (z >> 31n);
  }) as Seed;
}

/** A private xoshiro256** stream; successive calls shuffle the two main decks. */
export function createDeckShuffler(seed: readonly [bigint, bigint, bigint, bigint]) {
  const s = [...seed];
  // xoshiro's all-zero state is absorbing (possible only with OS entropy here).
  if ((s[0] | s[1] | s[2] | s[3]) === 0n) s[0] = 1n;
  const rotate = (word: bigint, bits: bigint) => ((word << bits) | (word >> (64n - bits))) & mask;
  // Reference: https://prng.di.unimi.it/xoshiro256starstar.c (public domain).
  const next = () => {
    const result = (rotate((s[1] * 5n) & mask, 7n) * 9n) & mask;
    const t = (s[1] << 17n) & mask;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
    s[2] ^= t; s[3] = rotate(s[3], 45n);
    return result;
  };
  return function shuffle<T>(cards: readonly T[]): T[] {
    const shuffled = [...cards];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const bound = BigInt(i + 1);
      // Discard the incomplete bucket: reducing every uint64 modulo bound
      // would make some Fisher–Yates indices more likely than others.
      const limit = range - range % bound;
      let value: bigint;
      do { value = next(); } while (value >= limit);
      const j = Number(value % bound);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  };
}
