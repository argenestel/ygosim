import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDuel, parseYdk } from "../src/index.js";
import { createDeckShuffler, seeds } from "../src/shuffle.js";

const deck = parseYdk(readFileSync(new URL("./fixtures/vanilla-dragons.ydk", import.meta.url), "utf8"));

async function openingHands(seed?: number, firstPlayer: 0 | 1 = 0) {
  const duel = await createDuel({ decks: [deck, deck], seed, firstPlayer });
  try {
    await duel.step();
    return ([0, 1] as const).map(player => duel.stateFor(player).cards
      .filter(card => card.controller === player && card.location === "hand")
      .sort((a, b) => a.sequence - b.sequence)
      .map(card => card.code));
  } finally { duel.destroy(); }
}

describe("opening deck shuffle", () => {
  it("gives both players at least 15 distinct hands across 20 seeds", async () => {
    const hands = await Promise.all(Array.from({ length: 20 }, (_, seed) => openingHands(seed)));
    for (const player of [0, 1]) {
      expect(hands.every(pair => pair[player].length === 5)).toBe(true);
      // Compare card sets too, so only changing draw order cannot pass.
      expect(new Set(hands.map(pair => [...pair[player]].sort((a, b) => a! - b!).join(","))).size).toBeGreaterThanOrEqual(15);
    }
  });

  it.each([0, 1, 2, 3, 99, 12345, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])(
    "reproduces both hands for seed %s without drawing the supplied list tail", async seed => {
      const hands = await openingHands(seed);
      expect(await openingHands(seed)).toEqual(hands);
      for (const hand of hands) expect(hand).not.toEqual(deck.main.slice(-5).reverse());
    },
  );

  it("advances the shuffle stream between identical decks and preserves player mapping", async () => {
    const hands = await openingHands(42);
    expect(hands[0]).not.toEqual(hands[1]);
    expect(await openingHands(42, 1)).toEqual(hands);
  });

  it("randomizes unseeded duels without modifying the caller's deck", async () => {
    const before = structuredClone(deck);
    const hands = await Promise.all(Array.from({ length: 5 }, () => openingHands()));
    expect(new Set(hands.map(pair => JSON.stringify(pair))).size).toBeGreaterThan(1);
    expect(deck).toEqual(before);
  });
});

describe("Fisher–Yates shuffle", () => {
  it("preserves cards and input arrays without consuming the core's seed", () => {
    const seed = seeds(42), before = [...seed];
    const shuffle = createDeckShuffler(seed);
    const cards = Object.freeze([1, 2, 2, 3, 4, 5]);
    expect(shuffle(cards).sort()).toEqual(cards);
    expect(cards).toEqual([1, 2, 2, 3, 4, 5]);
    expect(seed).toEqual(before);
    expect(shuffle([])).toEqual([]);
    expect(shuffle([1])).toEqual([1]);
  });

  it("reproduces successive shuffles with a fresh stream", () => {
    const cards = Array.from({ length: 60 }, (_, i) => i);
    const first = createDeckShuffler(seeds(12345)), second = createDeckShuffler(seeds(12345));
    for (let player = 0; player < 2; player++) expect(first(cards)).toEqual(second(cards));
  });

  it("handles the all-zero entropy state without entering an absorbing stream", () => {
    const cards = Array.from({ length: 40 }, (_, i) => i);
    const shuffled = createDeckShuffler([0n, 0n, 0n, 0n])(cards);
    expect(shuffled).not.toEqual(cards);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(cards);
  });

  it("rejects uint64 values in the incomplete modulo bucket", () => {
    // This xoshiro state emits UINT64_MAX twice, then 0xfffffffffb00007e.
    // For bound 3, MAX must be rejected; the third value selects index 2.
    const shuffle = createDeckShuffler([0n, 0x4fc71c71c71c71c7n, 0n, 0n]);
    expect(shuffle([0, 1, 2])).toEqual([1, 0, 2]);
  });

  it.each([20, 40, 60])("includes every card position roughly uniformly in %s-card opening hands", size => {
    const cards = Array.from({ length: size }, (_, i) => i);
    const counts = [Array<number>(size).fill(0), Array<number>(size).fill(0)];
    const samples = 2000;
    for (let seed = 0; seed < samples; seed++) {
      const shuffle = createDeckShuffler(seeds(seed));
      for (const player of [0, 1]) {
        // The core draws from the end; unique labels track original positions,
        // independently of real decks containing duplicate card codes.
        for (const position of shuffle(cards).slice(-5)) counts[player][position]++;
      }
    }
    const expected = samples * 5 / size;
    for (const observed of counts) {
      const chiSquare = observed.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
      // Loose deterministic sanity bounds, not a claim of statistical proof.
      expect(chiSquare).toBeLessThan(2 * size);
      for (const count of observed) {
        expect(count).toBeGreaterThan(expected * 0.7);
        expect(count).toBeLessThan(expected * 1.3);
      }
    }
  });
});
