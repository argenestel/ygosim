import type { Deck, Duel, Prompt, StepResult } from "@ygosim/protocol";
import type { RawCard, SqlCardDb } from "../src/carddb.js";
import { getBanlist, validateDeck } from "../src/formats.js";

export function rng(seed: number): () => number {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 0x1_0000_0000; };
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Released TCG cards only; tokens, skills, Rush and prerelease cards are excluded. */
export function tcgCard(card: RawCard): boolean {
  return !!(card.ot & 2) && !(card.ot & (0x100 | 0x200)) && !(card.type & (0x4000 | 0x8000000)) && !!(card.type & 7);
}

export function deckGenerator(db: SqlCardDb): (random: () => number) => Deck {
  const banlist = getBanlist("tcg");
  if (!banlist) throw new Error("TCG banlist unavailable; refusing to fuzz unvalidated decks");
  const identity = (code: number) => db.raw.get(code)?.alias || code;
  const limits = new Map<number, number>();
  for (const [code, limit] of banlist) limits.set(identity(code), Math.min(limits.get(identity(code)) ?? 3, limit));
  const pool = [...db.raw.values()].filter(card => tcgCard(card) && (limits.get(identity(card.code)) ?? 3) > 0);
  const extraType = 0x40 | 0x2000 | 0x800000 | 0x4000000;
  const main = pool.filter(card => !(card.type & extraType));
  const extra = pool.filter(card => !!(card.type & extraType));
  return random => {
    const used = new Map<number, number>();
    const pick = (cards: RawCard[], size: number): number[] => {
      const available = shuffled(cards, random);
      const codes: number[] = [];
      for (const card of available) {
        const id = identity(card.code), count = used.get(id) ?? 0;
        if (count >= (limits.get(id) ?? 3)) continue;
        codes.push(card.code); used.set(id, count + 1);
        if (codes.length === size) return shuffled(codes, random);
      }
      throw new Error(`Not enough legal cards to generate a ${size}-card deck`);
    };
    const deck = { main: pick(main, 40 + Math.floor(random() * 21)), extra: pick(extra, 15), side: [] };
    const validation = validateDeck(deck, "tcg", db);
    if (!validation.ok) throw new Error(`Generated illegal deck: ${validation.errors.join("; ")}`);
    return deck;
  };
}

function* combinations(ids: string[], count: number, start = 0, chosen: string[] = []): Generator<string[]> {
  if (chosen.length === count) { yield [...chosen]; return; }
  for (let i = start; i <= ids.length - (count - chosen.length); i++) {
    chosen.push(ids[i]); yield* combinations(ids, count, i + 1, chosen); chosen.pop();
  }
}

/** Generate bounded, random candidates; the engine validates weights and sums. */
export function* choices(prompt: Prompt, random: () => number): Generator<string[]> {
  const ids = shuffled(prompt.options.map(option => option.id), random);
  const min = prompt.min ?? 1, max = Math.min(prompt.max ?? min, ids.length);
  // Sentinels are alternatives to count/weight constraints, never combined with cards.
  const sentinels = ids.filter(id => ["cancel", "keep", "finish"].includes(id));
  const cards = ids.filter(id => !sentinels.includes(id));
  if (prompt.text.startsWith("Choose the card order.") || prompt.text.startsWith("Choose the chain order.")) {
    yield cards; yield ["keep"]; return;
  }
  if (min === 1 && max === 1) { for (const id of ids) yield [id]; return; }
  // Random samples avoid bias toward the smallest subset. Exhaustive fallback is lazy.
  for (let attempt = 0; attempt < 128 && max >= min; attempt++) {
    const count = min + Math.floor(random() * (max - min + 1));
    yield shuffled(cards, random).slice(0, count);
  }
  // Try valid escape choices before an exponential weighted-subset search.
  for (const id of sentinels) yield [id];
  for (const count of shuffled(Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i), random)) {
    yield* combinations(cards, count);
  }
}

export class ChoiceSearchError extends Error {}

export function respondRandomly(duel: Duel, pending: NonNullable<StepResult["pending"]>, random: () => number): string[] {
  let attempts = 0, last = "No enumerable candidates";
  for (const choose of choices(pending.prompt, random)) {
    if (++attempts > 50_000) throw new ChoiceSearchError(`Choice search exhausted for ${pending.prompt.kind}: ${last}`);
    try { duel.respond(pending.player, { promptId: pending.prompt.promptId, choose }); return choose; }
    catch (error) {
      last = String(error);
      // Only translator validation rejects candidates safely before submitting to WASM.
      if (!last.includes("invalid prompt response:")) throw error;
    }
  }
  throw new ChoiceSearchError(`No legal enumerable choice for ${pending.prompt.kind}: ${last}`);
}
