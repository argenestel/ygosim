import { describe, expect, it, vi } from "vitest";
import type { CardRef, Deck, DuelEvent, ServerMsg, StepResult } from "@ygosim/protocol";
import { MockDuel } from "../src/mock.js";
import { Room } from "../src/room.js";
import { createBot } from "../src/ai/index.js";
import { loadEngine } from "../src/engine.js";
import { sampleDecks } from "../src/decks.js";
import { spectatorEvents, spectatorState } from "../src/spectator.js";

const deck: Deck = { main: Array.from({ length: 40 }, (_, i) => 1000000 + i), extra: [], side: [] };
const card = (owner: 0 | 1, location: CardRef["location"], position: CardRef["position"] = "facedown"): CardRef => ({
  uid: `${owner}-${location}-${position}`, code: deck.main[owner], owner, controller: owner,
  location, position, sequence: 0, atk: 1234, def: 5678, level: 4,
});

class PrivateMockDuel extends MockDuel {
  cards: CardRef[] = ([0, 1] as const).flatMap(owner => [
    card(owner, "hand", "atk"), card(owner, "deck", "faceup"), card(owner, "extra"),
    card(owner, "banished"), card(owner, "mzone", "facedown_def"), card(owner, "szone"),
  ]);
  stateFor(viewer: 0 | 1) { return { ...super.stateFor(viewer), cards: this.cards }; }
  async step(): Promise<StepResult> {
    const result = await super.step();
    return { ...result, events: [...result.events, ...([0, 1] as const).map(player => ({ t: "draw" as const, player, cards: [card(player, "hand")] }))] };
  }
}

function expectPrivate(card: Partial<CardRef>) {
  for (const field of ["code", "atk", "def", "level"] as const) expect(card[field]).toBeUndefined();
  card.overlays?.forEach(expectPrivate);
}

function expectHidden(value: unknown, counts: [number, number]) {
  if (!value || typeof value !== "object") return;
  const c = value as CardRef;
  if (c.location) {
    if (c.location === "hand") counts[c.owner]++;
    if (c.location === "hand" || c.location === "deck" || c.position === "facedown" || c.position === "facedown_def") expectPrivate(c);
  }
  Object.values(value).forEach(v => expectHidden(v, counts));
}

async function watch(createDuel: ConstructorParameters<typeof Room>[0], duelDeck = deck) {
  const messages: ServerMsg[] = [];
  const room = new Room(createDuel, { botDelayMs: 0, seed: 1 }, undefined, "unlimited");
  room.spectators.add({ id: "spectator", name: "Watcher", kind: "human", send: m => messages.push(structuredClone(m)) });
  try {
    for (const id of ["p0", "p1"]) room.join({ id, name: id, kind: "bot", bot: createBot("normal"), send() {} }, duelDeck);
    await room.finished;
    expect(room.status).toBe("done");
    expect(messages.filter(m => m.type === "error")).toEqual([]);
    const states = messages.filter(m => m.type === "events");
    expect(states.length).toBeGreaterThan(1);
    const counts: [number, number] = [0, 0];
    states.forEach(m => expectHidden(m, counts));
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBeGreaterThan(0);
    expect(states.some(m => m.events.some(e => e.t === "win"))).toBe(true);
  } finally { await room.close(); }
}

describe("spectator privacy", () => {
  it("hides both players' private cards throughout a full MockDuel", async () => {
    await watch(async () => new PrivateMockDuel([deck, deck]));
  });

  it("redacts all card-bearing events, move origins, overlays and chain snapshots without mutating player views", () => {
    const duel = new PrivateMockDuel([deck, deck]);
    const set = card(0, "mzone", "facedown_def");
    set.overlays = [card(0, "grave", "faceup")];
    const publicCard = card(0, "grave", "faceup");
    duel.cards.push(set, publicCard, card(1, "extra", "faceup"));
    const playerState = duel.stateFor(0);
    vi.spyOn(duel, "stateFor").mockImplementation(viewer => ({ ...playerState, you: viewer, chain: [{ card: set, desc: "private effect" }] }));
    const events: DuelEvent[] = [
      { t: "move", card: publicCard, from: card(0, "hand"), reason: "discard" },
      { t: "move", card: set, from: { code: 123, atk: 100 }, reason: "set" },
      { t: "summon", card: set, kind: "set" }, { t: "activate", card: set, chainLink: 1 },
      { t: "attack", attacker: publicCard, target: set }, { t: "pos_change", card: set },
    ];
    const original = structuredClone(events);
    const redacted = spectatorEvents(duel, events);
    expectHidden(redacted, [0, 0]);
    expectPrivate((redacted[1] as Extract<DuelEvent, { t: "move" }>).from);
    const state = spectatorState(duel);
    state.cards.filter(c => c.location !== "grave" && !(c.location === "extra" && c.position === "faceup")).forEach(expectPrivate);
    expect(state.cards.find(c => c.uid === publicCard.uid)?.code).toBe(publicCard.code);
    expect(state.cards.at(-1)?.code).toBe(deck.main[1]);
    expectPrivate(state.chain[0].card);
    expect(state.chain[0].desc).toBe("");
    expect(events).toEqual(original);
    expect(duel.stateFor(0).cards[0].code).toBe(deck.main[0]);
  });

  it("excludes private hints even when their text duplicates a public hint", () => {
    const duel = new PrivateMockDuel([deck, deck]);
    const privateHint: DuelEvent = { t: "hint", text: "same text" };
    const publicHint: DuelEvent = { t: "hint", text: "same text" };
    vi.spyOn(duel, "redactEvents").mockImplementation((events, viewer) => events.filter(e => e !== privateHint || viewer === 0));
    expect(spectatorEvents(duel, [privateHint, publicHint])).toEqual([publicHint]);
  });

  it("preserves public LP costs for either player without labeling them as damage", () => {
    const duel = new PrivateMockDuel([deck, deck]);
    const events: DuelEvent[] = [
      { t: "pay_lp", player: 0, amount: 300, lp: 7700 },
      { t: "pay_lp", player: 1, amount: 1000, lp: 7000 },
    ];
    const result = spectatorEvents(duel, events);
    expect(result).toEqual(events);
    expect(result[0]).not.toBe(events[0]);
  });

  it("redacts the final snapshot when a player surrenders", async () => {
    const messages: ServerMsg[] = [];
    const room = new Room(async () => new PrivateMockDuel([deck, deck]));
    room.spectators.add({ id: "s", name: "s", kind: "human", send: m => messages.push(m) });
    const player = { id: "p0", name: "p0", kind: "human" as const, send(m: ServerMsg) { if (m.type === "prompt") room.surrender(player); } };
    room.join(player, deck);
    room.join({ id: "p1", name: "p1", kind: "bot", bot: createBot("normal"), send() {} }, deck);
    try {
      await room.finished;
      const final = messages.filter(m => m.type === "events").at(-1)!;
      expect(final.events).toContainEqual({ t: "win", winner: 1, reason: "surrender" });
      final.state.cards.forEach(expectPrivate);
    } finally { await room.close(); }
  });
});

it("hides both players' hands throughout a full real-engine duel", { skip: !process.env.YGOSIM_TEST_ENGINE, timeout: 60_000 }, async () => {
  const engine = await loadEngine();
  if (!engine) throw new Error("Real engine required");
  const realDeck = sampleDecks().find(d => d.id === "junk-synchro")!.deck;
  await watch(opts => engine.createDuel(opts), realDeck);
});
