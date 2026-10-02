import { describe, expect, it } from "vitest";
import { OcgLocation as L, OcgMessageType as M, type OcgCoreSync, type OcgDuelHandle } from "ocgcore-wasm";
import { SqlCardDb } from "../src/carddb.js";
import { DuelTracker } from "../src/state.js";
const strings = { system: new Map(), victory: new Map(), counter: new Map(), setname: new Map() };
const loc = (controller: 0 | 1, location: typeof L.HAND | typeof L.MZONE | typeof L.DECK | typeof L.EXTRA | typeof L.REMOVED | typeof L.SZONE | typeof L.GRAVE | typeof L.FZONE | typeof L.PZONE, sequence: number, code = 89631139, position: 1 | 2 | 4 | 8 = 8) => ({controller, location, sequence, code, position});
const make = (first: 0 | 1 = 0) => new DuelTracker(new SqlCardDb(), strings, 8000, first);
describe("viewer privacy and state translation", () => {
  it("hides opponent hand, deck and facedown statistics and prompt identities", () => {
    const tracker = make();
    tracker.card(loc(1, L.HAND, 0)); tracker.card(loc(0, L.DECK, 0)); tracker.card(loc(1, L.MZONE, 0));
    tracker.card(loc(1, L.MZONE, 1, 89631139, 1));
    const own = tracker.stateFor(1); expect(own.cards.find(c => c.location === "hand")?.code).toBe(89631139);
    const state = tracker.stateFor(0);
    expect(state.cards.filter(c => c.location === "hand" || c.location === "deck" || c.position === "facedown_def").every(c => c.code === undefined)).toBe(true);
    expect(state.cards.find(c => c.position === "atk")?.code).toBe(89631139);
    expect(tracker.promptCard(loc(1, L.HAND, 0, 0), 0).code).toBeUndefined();
    expect(tracker.promptCard(loc(0, L.DECK, 0), 0).code).toBeUndefined();
  });
  it("does not leak the source of a move or draw and preserves physical card identity", () => {
    const tracker = make();
    const before = tracker.card(loc(0, L.DECK, 0));
    const events = tracker.ingest({type: M.DRAW, player: 0, drawn: [{code: 89631139, position: 8}]});
    const draw = events[0]; if (draw.t !== "draw") throw Error("Expected draw");
    expect(draw.cards[0].uid).toBe(before.uid);
    const hidden = tracker.redactEvents(events, 1)[0]; if (hidden.t !== "draw") throw Error("Expected draw");
    expect(hidden.cards[0].code).toBeUndefined(); expect(draw.cards[0].code).toBe(89631139);
    const moves = tracker.ingest({type: M.MOVE, card: 89631139, from: loc(0, L.HAND, 0), to: loc(0, L.MZONE, 0, 89631139, 1)});
    const move = tracker.redactEvents(moves, 1)[0]; if (move.t !== "move") throw Error("Expected move");
    expect(move.from.code).toBeUndefined(); expect(move.card.code).toBe(89631139);
    expect(moves[0].t === "move" && moves[0].card.uid).toBe(before.uid);
  });
  it("redacts historical events using their event-time positions", () => {
    const tracker = make();
    const events = tracker.ingest({type: M.SET, ...loc(1, L.MZONE, 0)});
    tracker.ingest({type: M.POS_CHANGE, ...loc(1, L.MZONE, 0, 89631139, 1), prev_position: 8});
    const e = tracker.redactEvents(events, 0)[0]; expect(e.t === "summon" && e.card.code).toBeUndefined();
    expect(e.t === "summon" && e.card.position).toBe("facedown_def");
  });
  it("shows public face-up hand draws while hiding facedown banished cards", () => {
    const tracker = make();
    const events = tracker.ingest({type: M.DRAW, player: 1, drawn: [{code: 89631139, position: 5}]});
    const event = tracker.redactEvents(events, 0)[0];
    expect(event.t === "draw" && event.cards[0]).toMatchObject({code: 89631139, position: "faceup"});
    tracker.card(loc(1,L.REMOVED,0));
    expect(tracker.stateFor(0).cards.find(c=>c.location === "banished")?.code).toBeUndefined();
  });

  it("normalizes draws and moves for each viewer without changing historical visibility", () => {
    const tracker = make();
    const draws = tracker.ingest({type: M.DRAW, player: 0, drawn: [{code: 89631139, position: 8}]});
    const ownDraw = tracker.redactEvents(draws, 0)[0];
    const otherDraw = tracker.redactEvents(draws, 1)[0];
    expect(ownDraw.t === "draw" && ownDraw.cards[0]).toMatchObject({code: 89631139, position: "faceup"});
    expect(otherDraw.t === "draw" && otherDraw.cards[0].position).toBe("facedown");
    expect(otherDraw.t === "draw" && otherDraw.cards[0].code).toBeUndefined();
    expect(tracker.stateFor(0).cards[0].position).toBe("faceup");
    const moves = tracker.ingest({type: M.MOVE, card: 89631139, from: loc(0, L.HAND, 0), to: loc(0, L.GRAVE, 0)});
    const move = tracker.redactEvents(moves, 1)[0];
    expect(move.t === "move" && move.card).toMatchObject({code: 89631139, position: "faceup"});
    expect(move.t === "move" && move.from.position).toBe("facedown");
    expect(tracker.stateFor(1).cards[0]).toMatchObject({code: 89631139, position: "faceup"});
    const historicalDraw = tracker.redactEvents(draws, 1)[0];
    expect(historicalDraw.t === "draw" && historicalDraw.cards[0].position).toBe("facedown");
    expect(historicalDraw.t === "draw" && historicalDraw.cards[0].code).toBeUndefined();
  });

  it("normalizes non-field positions while retaining detailed field orientations", () => {
    const tracker = make();
    tracker.card(loc(0, L.HAND, 0, 100, 8));
    tracker.card(loc(1, L.HAND, 0, 101, 8));
    tracker.card(loc(1, L.HAND, 1, 102, 1));
    tracker.card(loc(0, L.DECK, 0, 103, 1));
    tracker.card(loc(0, L.GRAVE, 0, 104, 8));
    tracker.card(loc(0, L.EXTRA, 0, 105, 1));
    tracker.card(loc(1, L.EXTRA, 0, 106, 8));
    tracker.card(loc(0, L.REMOVED, 0, 107, 8));
    tracker.card(loc(1, L.REMOVED, 0, 108, 1));
    tracker.card(loc(0, L.MZONE, 0, 109, 1));
    tracker.card(loc(0, L.MZONE, 5, 110, 8));
    tracker.card(loc(0, L.SZONE, 0, 111, 4));
    tracker.card(loc(0, L.FZONE, 0, 112, 2));
    tracker.card(loc(0, L.PZONE, 0, 113, 8));

    const state = tracker.stateFor(0);
    const card = (controller: 0 | 1, location: string, sequence: number) => state.cards.find(c => c.controller === controller && c.location === location && c.sequence === sequence)!;
    expect(card(0, "hand", 0)).toMatchObject({code: 100, position: "faceup"});
    expect(card(1, "hand", 0).position).toBe("facedown");
    expect(card(1, "hand", 0).code).toBeUndefined();
    expect(card(1, "hand", 1)).toMatchObject({code: 102, position: "faceup"});
    expect(card(0, "deck", 0).position).toBe("facedown");
    expect(card(0, "deck", 0).code).toBeUndefined();
    expect(card(0, "grave", 0)).toMatchObject({code: 104, position: "faceup"});
    expect(card(0, "extra", 0)).toMatchObject({code: 105, position: "faceup"});
    expect(card(1, "extra", 0).position).toBe("facedown");
    expect(card(1, "extra", 0).code).toBeUndefined();
    expect(card(0, "banished", 0)).toMatchObject({code: 107, position: "facedown"});
    expect(card(1, "banished", 0)).toMatchObject({code: 108, position: "faceup"});
    expect(card(0, "mzone", 0).position).toBe("atk");
    expect(card(0, "emzone", 5).position).toBe("facedown_def");
    expect(card(0, "szone", 0).position).toBe("def");
    expect(card(0, "fzone", 0).position).toBe("facedown");
    expect(card(0, "pzone", 0).position).toBe("facedown_def");

    expect(tracker.promptCard(loc(1, L.HAND, 2, 114, 8), 0)).toMatchObject({position: "facedown"});
    expect(tracker.promptCard(loc(1, L.HAND, 2, 114, 8), 0).code).toBeUndefined();
    const hiddenPrompt = tracker.promptCard(loc(1, L.HAND, 3, 0, 8), 0);
    expect(hiddenPrompt.position).toBe("facedown");
    expect(hiddenPrompt.code).toBeUndefined();
  });
  it("remaps turns, ownership, damage and wins for player 1 starting", () => {
    const tracker = make(1);
    tracker.ingest({type: M.NEW_TURN, player: 0}); tracker.ingest({type: M.NEW_PHASE, phase: 4});
    tracker.ingest({type: M.DAMAGE, player: 0, amount: 1200});
    tracker.card(loc(0, L.HAND, 0));
    const state = tracker.stateFor(1); expect(state.turnPlayer).toBe(1); expect(state.phase).toBe("main1"); expect(state.lp).toEqual([8000,6800]); expect(state.cards[0].owner).toBe(1);
    const e = tracker.ingest({type: M.WIN, player: 0, reason: 1}); expect(e[0].t === "win" && e[0].winner).toBe(1);
  });
  it("isolates state snapshots and honors public-query hand cards", () => {
    const tracker = make();
    const core = {duelQueryLocation: (_handle: unknown, q: {controller:number;location:number}) => q.controller === 1 && q.location === L.HAND ? [{code: 89631139, owner: 1, position: 8, attack: 3000, defense: 2500, level: 8, rank: 0, link: {rating: 0, marker: 0}, isPublic: true}] : []} as unknown as OcgCoreSync;
    tracker.refresh(core, {} as OcgDuelHandle);
    const state = tracker.stateFor(0); expect(state.cards[0].code).toBe(89631139); expect(state.cards[0].position).toBe("faceup"); expect(state.cards[0].level).toBe(8); expect(state.cards[0].uid).toBe(tracker.card(loc(1,L.HAND,0)).uid); state.cards[0].code = 0; state.lp[0] = 0;
    expect(tracker.stateFor(0).cards[0].code).toBe(89631139); expect(tracker.stateFor(0).lp[0]).toBe(8000);
  });
  it("assigns valid ownership to cards created outside an existing zone", () => {
    const tracker = make();
    const events = tracker.ingest({type:M.MOVE,card:123,from:{controller:2 as 0,location:0 as 1,sequence:0,position:0 as 1},to:loc(1,L.MZONE,0,123,1)});
    const e=events[0]; if(e.t !== "move") throw Error("Expected move");
    expect(e.card.owner).toBe(1); expect(e.card.controller).toBe(1); expect(e.from).toEqual({});
  });
  it("makes only a reversed deck's top card public", () => {
    const tracker = make();
    const core = {duelQueryLocation: (_handle: unknown, q: {controller:number;location:number}) => q.controller === 0 && q.location === L.DECK ? [{code: 89631139, owner: 0, position: 8}, {code: 46986414, owner: 0, position: 8}] : []} as unknown as OcgCoreSync;
    tracker.ingest({type:M.REVERSE_DECK});
    tracker.refresh(core,{} as OcgDuelHandle);
    expect(tracker.stateFor(1).cards.map(c=>c.code)).toEqual([undefined,46986414]);
    tracker.ingest({type:M.REVERSE_DECK});
    tracker.refresh(core,{} as OcgDuelHandle);
    expect(tracker.stateFor(1).cards.every(c=>c.code === undefined)).toBe(true);
  });
  it("reveals confirmed cards only to the designated viewer", () => {
    const tracker = make();
    const events = tracker.ingest({type: M.CONFIRM_CARDS, player: 0, cards: [loc(1,L.HAND,0)]});
    const seen = tracker.redactEvents(events,0)[0]; expect(seen.t === "move" && seen.card.code).toBe(89631139); expect(seen.t === "move" && seen.card.position).toBe("faceup");
    expect(tracker.stateFor(0).cards[0].code).toBeUndefined();
  });
});
