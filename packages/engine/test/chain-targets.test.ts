import { describe, expect, it } from "vitest";
import { OcgLocation as L, OcgMessageType as M, OcgPosition as P, type OcgMessage } from "ocgcore-wasm";
import { SqlCardDb } from "../src/carddb.js";
import { DuelTracker } from "../src/state.js";
import { translatePrompt } from "../src/prompts.js";
import { controlledDuel } from "./helpers/controlled-duel.js";

const strings = { system: new Map(), victory: new Map(), counter: new Map(), setname: new Map() };
const activation = { code: 100, controller: 0 as const, location: L.MZONE, sequence: 0, position: P.FACEUP_ATTACK };
const publicTarget = { code: 200, controller: 1 as const, location: L.MZONE, sequence: 0, position: P.FACEUP_ATTACK };
const hiddenTarget = { code: 300, controller: 1 as const, location: L.SZONE, sequence: 0, position: P.FACEDOWN_DEFENSE };
function setup(first: 0 | 1 = 0) {
  const db = new SqlCardDb();
  for (const [code, name] of [[100, "Little Knight"], [200, "Public Target"], [300, "Secret Target"]] as const) {
    db.raw.set(code, { code, name, alias: 0, setcode: 0n, type: 1, atk: 1000, def: 1000, level: 4, race: 1, attribute: 1, ot: 1, desc: "", strs: [] });
  }
  const tracker = new DuelTracker(db, strings, 8000, first);
  tracker.card(publicTarget); tracker.card(hiddenTarget);
  tracker.ingest({ type: M.CHAINING, ...activation, triggering_controller: 0, triggering_location: L.MZONE, triggering_sequence: 0, description: 0n, chain_size: 1 });
  tracker.ingest({ type: M.BECOME_TARGET, cards: [publicTarget, hiddenTarget] });
  return { tracker, db };
}

describe("chain target context", () => {
  it.each([0, 1] as const)("records and redacts targets with firstPlayer %s", first => {
    const { tracker } = setup(first);
    const state = tracker.stateFor(tracker.player(0));
    expect(state.chain[0].card.code).toBe(100);
    expect(state.chain[0].targets).toHaveLength(2);
    expect(state.chain[0].targets![0].code).toBe(200);
    expect(state.chain[0].targets![1].code).toBeUndefined();
    expect(state.chain[0].targets![1].uid).toBe(state.cards.find(c => c.location === "szone")!.uid);
    expect(tracker.stateFor(tracker.player(1)).chain[0].targets![1].code).toBe(300);
    tracker.ingest({ type: M.BECOME_TARGET, cards: [publicTarget] });
    expect(tracker.stateFor(tracker.player(0)).chain[0].targets).toHaveLength(2);
    tracker.ingest({ type: M.CONFIRM_CARDS, player: 0, cards: [hiddenTarget] });
    expect(tracker.stateFor(tracker.player(0)).chain[0].targets![1].code).toBe(300);
    tracker.ingest({ type: M.CHAINING, ...activation, triggering_controller: 0, triggering_location: L.MZONE, triggering_sequence: 0, description: 0n, chain_size: 2 });
    tracker.ingest({ type: M.BECOME_TARGET, cards: [hiddenTarget] });
    expect(tracker.stateFor(tracker.player(0)).chain[1].targets).toHaveLength(1);
    tracker.ingest({ type: M.CHAIN_END });
    expect(tracker.stateFor(0).chain).toEqual([]);
  });

  it.each([
    { type: M.SELECT_CHAIN, player: 0, spe_count: 0, forced: false, hint_timing: 0, hint_timing_other: 0, selects: [] },
    { type: M.SELECT_EFFECTYN, player: 0, ...activation, description: 0n },
    { type: M.SELECT_YESNO, player: 0, description: 0n },
  ] as OcgMessage[])("includes redacted target context in response prompt $type", message => {
    const { tracker, db } = setup();
    const prompt = translatePrompt(message, { db, strings, viewer: 0, promptId: "chain", chain: tracker.stateFor(0).chain, card: loc => tracker.promptCard(loc, 0) })!.prompt;
    expect(prompt.text).toContain("Chain: 1. Little Knight; targets: Public Target, Opponent's set card");
    expect(JSON.stringify(prompt)).not.toContain("Secret Target");
  });
});

describe("real-core selection and chain context", () => {
  it("shows Tenki's own Deck search names without exposing the Deck in state", async () => {
    const TENKI = 57103969, FRAKTALL = 87209160;
    const h = await controlledDuel([
      { code: TENKI, player: 0, location: L.HAND },
      { code: FRAKTALL, player: 0, location: L.DECK },
    ]);
    try {
      await h.until(p => p.player === 0 && p.prompt.kind === "idle");
      await h.answer(o => o.card?.code === TENKI && o.id.startsWith("activate:"));
      const search = await h.until(p => p.player === 0 && p.prompt.kind === "select_card");
      const option = search.prompt.options.find(o => o.card?.code === FRAKTALL);
      expect(option?.label).toContain("Fraktall");
      expect(h.duel.stateFor(0).cards.filter(c => c.location === "deck").every(c => c.code === undefined)).toBe(true);
    } finally { h.duel.destroy(); }
  });

  it("shows Book of Moon's chosen target when Compulsory can respond", async () => {
    const BOOK = 14087893, BLUE = 89631139, COMPULSE = 94192409;
    const h = await controlledDuel([
      { code: BOOK, player: 0, location: L.HAND },
      { code: BLUE, player: 1, location: L.MZONE, position: P.FACEUP_ATTACK },
      { code: COMPULSE, player: 1, location: L.SZONE, position: P.FACEDOWN_DEFENSE },
    ]);
    try {
      await h.until(p => p.player === 0 && p.prompt.kind === "idle");
      await h.answer(o => o.card?.code === BOOK && o.id.startsWith("activate:"));
      await h.until(p => p.prompt.kind === "select_card");
      await h.answer(o => o.card?.code === BLUE);
      const response = await h.until(p => p.player === 1 && p.prompt.kind === "select_chain");
      expect(h.duel.stateFor(1).chain[0].targets?.[0].code).toBe(BLUE);
      expect(response.prompt.text).toContain("Book of Moon; targets: Blue-Eyes White Dragon");
    } finally { h.duel.destroy(); }
  });
});
