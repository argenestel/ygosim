import { describe, expect, it } from "vitest";
import type { CardRef, Duel, DuelState, Prompt } from "@ygosim/protocol";
import { loadCardDb, type SqlCardDb } from "../src/carddb.js";
import { validateDeck } from "../src/formats.js";
import { createDuel } from "../src/index.js";
import { choices, deckGenerator, respondRandomly, rng, tcgCard } from "../scripts/fuzz-support.js";

function allStateCards(state: DuelState): CardRef[] {
  const walk = (cards: readonly CardRef[]): CardRef[] => cards.flatMap(card => [card, ...(card.overlays ? walk(card.overlays) : [])]);
  return walk([...state.cards, ...state.chain.map(chain => chain.card)]);
}

function matchingStateCard(state: DuelState, promptCard: CardRef): CardRef | undefined {
  const cards = allStateCards(state);
  return cards.find(card => card.uid === promptCard.uid)
    ?? cards.find(card => card.controller === promptCard.controller && card.location === promptCard.location && card.sequence === promptCard.sequence);
}

function expectPromptCardVisibleAsState(state: DuelState, promptCard: CardRef, context: string, corresponding?: CardRef): void {
  const stateCard = corresponding ?? matchingStateCard(state, promptCard);
  expect(stateCard, `${context}: prompt card ${promptCard.uid} is absent from stateFor(${state.you})`).toBeDefined();
  if (!stateCard) return;

  // A core-offered own Deck choice grants identity for that option only.
  if (promptCard.controller === state.you && promptCard.location === "deck") {
    expect(promptCard.code, `${context}: own Deck option lost identity`).toBeDefined();
    expect(stateCard.code, `${context}: state exposed the own Deck`).toBeUndefined();
    return;
  }
  if (stateCard.code === undefined) {
    expect(promptCard.code, `${context}: hidden prompt card leaked code`).toBeUndefined();
    expect(promptCard.atk, `${context}: hidden prompt card leaked ATK`).toBeUndefined();
    expect(promptCard.def, `${context}: hidden prompt card leaked DEF`).toBeUndefined();
    expect(promptCard.level, `${context}: hidden prompt card leaked level`).toBeUndefined();
    expect(promptCard.counters, `${context}: hidden prompt card leaked counters`).toBeUndefined();
    expect(promptCard.overlays, `${context}: hidden prompt card leaked overlay identities`).toBeUndefined();
    return;
  }

  expect(promptCard.code, `${context}: visible prompt card changed code`).toBe(stateCard.code);
  for (const [index, overlay] of (promptCard.overlays ?? []).entries()) {
    const stateOverlay = stateCard.overlays?.find(candidate => candidate.uid === overlay.uid)
      ?? stateCard.overlays?.[index];
    expect(stateOverlay, `${context}: prompt overlay ${index} is absent from stateFor(${state.you})`).toBeDefined();
    if (stateOverlay) expectPromptCardVisibleAsState(state, overlay, `${context}/overlay[${index}]`, stateOverlay);
  }
}

function expectPromptCardsRedacted(duel: Duel, pending: NonNullable<Awaited<ReturnType<Duel["step"]>>["pending"]>, db: SqlCardDb, revealed = new Map<string, CardRef>()): void {
  const state = duel.stateFor(pending.player);
  const otherState = duel.stateFor((pending.player ^ 1) as 0 | 1);
  for (const [index, option] of pending.prompt.options.entries()) {
    if (!option.card) continue;
    if (revealed.has(option.card.uid)) {
      expect(option.card.code).toBe(revealed.get(option.card.uid)!.code);
      continue;
    }
    const context = `${pending.prompt.kind} option ${index} (${option.id})`;
    const stateCard = matchingStateCard(state, option.card);
    if (stateCard?.code === undefined && !(option.card.controller === state.you && option.card.location === "deck")) {
      const otherCard = matchingStateCard(otherState, option.card);
      if (otherCard?.code !== undefined) {
        expect(option.label.toLocaleLowerCase()).not.toContain(db.name(otherCard.code).toLocaleLowerCase());
      }
    }
    expectPromptCardVisibleAsState(state, option.card, context);
  }
}

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

  it("never exposes hidden prompt card identities across seeded random duels", async () => {
    const db = await loadCardDb(), generate = deckGenerator(db);
    const seeds = [0, 1, 17, 42, 20261002, 20261077, 20261176, 20261183];
    const decisionCap = 400;
    let decisionsChecked = 0;
    for (const firstPlayer of [0, 1] as const) for (const seed of seeds) {
      const random = rng(seed);
      const duel = await createDuel({ decks: [generate(random), generate(random)], format: "tcg", seed, firstPlayer });
      try {
        const revealed = [new Map<string, CardRef>(), new Map<string, CardRef>()];
        let result = await duel.step();
        for (let decision = 0; !result.ended && decision < decisionCap; decision++) {
          expect(result.pending, `seed ${seed}, first player ${firstPlayer}: missing pending prompt`).toBeDefined();
          if (!result.pending) break;
          for (const viewer of [0, 1] as const) {
            for (const event of duel.redactEvents(result.events, viewer)) {
              if (event.t === "shuffle") {
                for (const [uid, card] of revealed[viewer]) if (card.controller === event.player && card.location === event.location) revealed[viewer].delete(uid);
              } else if (event.t === "move") {
                revealed[viewer].delete(event.card.uid);
                if (event.reason === "reveal" && event.card.code) revealed[viewer].set(event.card.uid, event.card);
              }
            }
          }
          expectPromptCardsRedacted(duel, result.pending, db, revealed[result.pending.player]);
          respondRandomly(duel, result.pending, random);
          decisionsChecked++;
          result = await duel.step();
        }
      } finally {
        duel.destroy();
      }
    }
    expect(decisionsChecked, "seeded fuzz should inspect hundreds of decisions").toBeGreaterThan(500);
  }, 30_000);

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
