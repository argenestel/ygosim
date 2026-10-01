import { readFileSync } from "node:fs";
import type { CardRef, DuelEvent, PlayerIdx, Prompt, PromptOption, StepResult } from "@ygosim/protocol";
import { describe, expect, it } from "vitest";
import { createDuel, loadCardDb, parseYdk } from "../src/index.js";

const deckText = (name: string) => readFileSync(new URL(`../decks/${name}`, import.meta.url), "utf8");
const decks = () => [parseYdk(deckText("vanilla-dragons.ydk")), parseYdk(deckText("vanilla-sea.ydk"))] as const;

function rng(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function* combinations(ids: readonly string[], size: number, start = 0, chosen: string[] = []): Generator<string[]> {
  if (chosen.length === size) {
    yield [...chosen];
    return;
  }
  for (let i = start; i <= ids.length - (size - chosen.length); i++) {
    chosen.push(ids[i]);
    yield* combinations(ids, size, i + 1, chosen);
    chosen.pop();
  }
}

function optionScore(option: PromptOption): number {
  const label = option.label.toLowerCase();
  if (/\b(?:end|cancel|pass|skip|no|none)\b/.test(label)) return -3;
  if (/\b(?:attack|summon|activate|set|yes|direct)\b/.test(label)) return 3;
  return 0;
}

function candidates(prompt: Prompt, random: () => number): string[][] {
  const options = [...prompt.options].sort((a, b) => optionScore(b) - optionScore(a));
  const ids = shuffled(options.map((option) => option.id), random);
  if (!ids.length) return [[]];

  // select_sum min/max are count bounds; the translator validates the weighted
  // card sum, so try every count-bounded subset until one satisfies it.
  if (prompt.kind === "select_sum") {
    const min = Math.max(0, Math.min(ids.length, prompt.min ?? 1));
    const max = Math.max(min, Math.min(ids.length, prompt.max ?? min));
    const out: string[][] = [];
    for (let size = min; size <= max && out.length < 100_000; size++) {
      for (const choice of combinations(ids, size)) {
        out.push(choice);
        if (out.length >= 100_000) break;
      }
    }
    return out;
  }

  const min = Math.max(0, Math.min(ids.length, prompt.min ?? 1));
  const max = Math.max(min, Math.min(ids.length, prompt.max ?? min));
  const out: string[][] = [];
  for (let size = min; size <= max && out.length < 100_000; size++) {
    for (const choice of combinations(ids, size)) {
      out.push(choice);
      if (out.length >= 100_000) break;
    }
  }
  return out;
}

function respondRandomly(duel: Awaited<ReturnType<typeof createDuel>>, pending: NonNullable<StepResult["pending"]>, random: () => number): void {
  let last: unknown;
  for (const choose of candidates(pending.prompt, random)) {
    try {
      duel.respond(pending.player, { promptId: pending.prompt.promptId, choose });
      return;
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`no legal response for ${pending.prompt.kind}: ${String(last)}`);
}

function eventCards(event: DuelEvent): CardRef[] {
  switch (event.t) {
    case "draw": return event.cards;
    case "move": return [event.card];
    case "summon": case "activate": case "pos_change": return [event.card];
    case "attack": return [event.attacker, ...(event.target ? [event.target] : [])];
    default: return [];
  }
}

function expectPrivateCardsRedacted(cards: readonly CardRef[], viewer: PlayerIdx): void {
  for (const card of cards) {
    const privateToViewer = card.location === "deck" || card.location === "extra" ||
      (card.controller !== viewer && (card.location === "hand" || card.position.startsWith("facedown")));
    if (privateToViewer) expect(card.code).toBeUndefined();
  }
}

describe("engine integration", () => {
  it.each([7, 42, 20261001])("loads two legal fixture decks and completes a duel through enumerable actions (seed %s)", async (seed) => {
    const db = await loadCardDb();
    const [firstDeck, secondDeck] = decks();
    for (const deck of [firstDeck, secondDeck]) {
      expect(deck.main).toHaveLength(40);
      const copies = new Map<number, number>();
      for (const code of [...deck.main, ...deck.extra, ...deck.side]) {
        expect(db.get(code), `missing card ${code}`).toBeDefined();
        copies.set(code, (copies.get(code) ?? 0) + 1);
      }
      expect(Math.max(...copies.values())).toBeLessThanOrEqual(3);
    }

    const duel = await createDuel({
      decks: [firstDeck, secondDeck], seed,
      firstPlayer: 0, chooseFirstTurn: false,
    });
    try {
      let result = await duel.step();
      expect(result.pending).toBeDefined();
      const initial = result.pending!;
      const repeated = await duel.step();
      expect(repeated.pending?.prompt).toEqual(initial.prompt);
      expect(repeated.events).toEqual([]);
      expect(() => duel.respond((initial.player ^ 1) as PlayerIdx, { promptId: initial.prompt.promptId, choose: [] })).toThrow();
      expect(() => duel.respond(initial.player, { promptId: "stale-prompt", choose: [] })).toThrow();

      const initialState0 = duel.stateFor(0);
      const initialState1 = duel.stateFor(1);
      expect(initialState0.duelId).toBe(initialState1.duelId);
      expectPrivateCardsRedacted(initialState0.cards, 0);
      expectPrivateCardsRedacted(initialState1.cards, 1);

      const random = rng(seed);
      let decisions = 0;
      while (!result.ended && decisions++ < 2_500) {
        if (result.events.length) {
          expectPrivateCardsRedacted(duel.redactEvents(result.events, 0).flatMap(eventCards), 0);
          expectPrivateCardsRedacted(duel.redactEvents(result.events, 1).flatMap(eventCards), 1);
        }
        if (!result.pending) throw new Error("engine returned neither a prompt nor an ending");
        respondRandomly(duel, result.pending, random);
        result = await duel.step();
      }
      expect(result.ended, "random legal play should finish").toBeDefined();
      expect(decisions).toBeLessThan(2_500);
    } finally {
      duel.destroy();
    }
  }, 120_000);

  it("honors first-player options and keeps duel identity stable across setup", async () => {
    const [firstDeck, secondDeck] = decks();
    const fixed = await createDuel({ decks: [firstDeck, secondDeck], seed: 1, startingLp: 800, firstPlayer: 1 });
    expect(fixed.stateFor(0).turnPlayer).toBe(1);
    fixed.destroy();

    const chosen = await createDuel({ decks: [firstDeck, secondDeck], seed: 2, startingLp: 800, chooseFirstTurn: true });
    const before = chosen.stateFor(0).duelId;
    try {
      const prompt = await chosen.step();
      expect(prompt.pending?.prompt.kind).toBe("first_turn");
      chosen.respond(0, { promptId: prompt.pending!.prompt.promptId, choose: ["1"] });
      expect(chosen.stateFor(0).duelId).toBe(before);
      expect((await chosen.step()).pending).toBeDefined();
    } finally {
      chosen.destroy();
      chosen.destroy();
    }
  });
});
