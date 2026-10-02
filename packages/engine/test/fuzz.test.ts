import { describe, expect, it } from "vitest";
import type { Duel, Prompt } from "@ygosim/protocol";
import { loadCardDb } from "../src/carddb.js";
import { validateDeck } from "../src/formats.js";
import { createDuel } from "../src/index.js";
import { choices, deckGenerator, respondRandomly, rng, tcgCard } from "../scripts/fuzz-support.js";

describe("fuzz harness", () => {
  it.each([[20261002, 379], [20261077, 167], [20261176, 84], [20261183, 5]])(
    "crosses a previously broken shuffle/sum decision (seed %s)", async (seed, failureDecision) => {
      const db = await loadCardDb(), generate = deckGenerator(db), random = rng(seed);
      const duel = await createDuel({ decks: [generate(random), generate(random)], format: "tcg", seed });
      try {
        for (let decision = 0; decision <= failureDecision + 1; decision++) {
          const result = await duel.step();
          expect(result.ended).toBeUndefined();
          expect(result.pending).toBeDefined();
          respondRandomly(duel, result.pending!, random);
        }
      } finally { duel.destroy(); }
    }, 30_000,
  );

  it("does not treat virtual card-data lookups as fatal errors (seed 20261048)", async () => {
    const db = await loadCardDb(), generate = deckGenerator(db), random = rng(20261048);
    const duel = await createDuel({ decks: [generate(random), generate(random)], format: "tcg", seed: 20261048 });
    try {
      for (let decision = 0; decision < 20; decision++) {
        const result = await duel.step();
        if (result.ended) break;
        expect(result.pending).toBeDefined();
        respondRandomly(duel, result.pending!, random);
      }
    } finally { duel.destroy(); }
  });

  it("generates reproducible decks that pass TCG validation from released TCG cards", async () => {
    const db = await loadCardDb(), generate = deckGenerator(db);
    expect(generate(rng(17))).toEqual(generate(rng(17)));
    for (let seed = 0; seed < 30; seed++) {
      const deck = generate(rng(seed));
      expect(validateDeck(deck, "tcg", db)).toEqual({ ok: true, errors: [], format: "tcg" });
      for (const code of [...deck.main, ...deck.extra]) expect(tcgCard(db.raw.get(code)!)).toBe(true);
    }
    const card = db.raw.get(89631139)!;
    expect(tcgCard({ ...card, ot: 1 })).toBe(false);
    expect(tcgCard({ ...card, ot: 2 | 0x100 })).toBe(false);
    expect(tcgCard({ ...card, ot: 2 | 0x200 })).toBe(false);
    expect(tcgCard({ ...card, type: 1 | 0x4000 })).toBe(false);
    expect(tcgCard({ ...card, type: 0x8000000 })).toBe(false);
  });

  it("searches weighted choices without hiding errors after response submission", () => {
    const prompt: Prompt = { promptId: "p", kind: "select_sum", text: "Sum", min: 1, max: 3,
      options: ["0", "1", "2"].map(id => ({ id, label: id })) };
    const submitted: string[][] = [];
    const duel = { respond: (_player, action) => {
      if (action.choose.join(",") !== "0,2") throw new Error("invalid prompt response: wrong sum");
      submitted.push(action.choose);
    } } as Duel;
    expect(respondRandomly(duel, { player: 0, prompt }, rng(3))).toEqual(["0", "2"]);
    expect(submitted).toHaveLength(1);
    const broken = { respond: () => { throw new Error("WASM submission failed"); } } as unknown as Duel;
    expect(() => respondRandomly(broken, { player: 0, prompt }, rng(3))).toThrow("WASM submission failed");
  });

  it("allows cancellation despite card-count bounds and randomizes sort permutations", () => {
    const prompt: Prompt = { promptId: "p", kind: "select_card", text: "Choose the card order.", min: 1, max: 3,
      options: ["0", "1", "2", "keep"].map(id => ({ id, label: id })) };
    const candidates = [...choices(prompt, rng(1))];
    expect(candidates[0].sort()).toEqual(["0", "1", "2"]);
    expect(candidates[1]).toEqual(["keep"]);
    const cancel: Prompt = { ...prompt, text: "Select", min: 2, max: 2, options: ["0", "1", "cancel"].map(id => ({ id, label: id })) };
    expect([...choices(cancel, rng(1))]).toContainEqual(["cancel"]);
  });
});
