import { describe, expect, it } from "vitest";
import { OcgLocation as L, OcgMessageType as M, type OcgMessage } from "ocgcore-wasm";
import { SqlCardDb, type RawCard } from "../src/carddb.js";
import { DuelTracker } from "../src/state.js";

const strings = { system: new Map(), victory: new Map(), counter: new Map(), setname: new Map() };
const loc = { code: 123, controller: 0 as const, location: L.MZONE, sequence: 0, position: 1 as const };
function tracker(type = 0) {
  const db = new SqlCardDb();
  db.raw.set(loc.code, { code: loc.code, type } as RawCard);
  return new DuelTracker(db, strings, 8000, 0);
}
const kinds = [
  [0x40, 0x40000, "fusion"], [0x2000, 0x80000, "synchro"],
  [0x80, 0x100000, "ritual"], [0x800000, 0x200000, "xyz"],
  [0x4000000, 0x10000000, "link"],
] as const;

describe("summon kinds", () => {
  it.each(kinds.filter(([, , kind]) => kind !== "ritual"))("uses Extra Deck card type %s as fallback when leaving the extra deck", (type, _reason, kind) => {
    const duel = tracker(type | 1);
    duel.ingest({ type: M.MOVE, card: loc.code, from: { ...loc, location: L.EXTRA }, to: loc });
    expect(duel.ingest({ type: M.SPSUMMONING, ...loc })[0]).toMatchObject({ t: "summon", kind });
    expect(duel.ingest({ type: M.SPSUMMONING, ...loc })[0]).toMatchObject({ kind: "special" });
  });
  it.each(kinds)("prioritizes move reason over card type %s", (_type, reason, kind) => {
    const duel = tracker(0x1000001);
    const move = { type: M.MOVE, card: loc.code, from: { ...loc, location: L.EXTRA }, to: loc, reason: reason | 0x40 };
    duel.ingest(move as OcgMessage);
    expect(duel.ingest({ type: M.SPSUMMONING, ...loc })[0]).toMatchObject({ kind });
    // A consumed reason must not classify a later summon into the same slot.
    expect(duel.ingest({ type: M.SPSUMMONING, ...loc })[0]).toMatchObject({ kind: "special" });
  });
  it("accepts a reason directly on summon content", () => {
    const message = { type: M.SPSUMMONING, ...loc, reason: 0x80000 };
    expect(tracker(0x41).ingest(message as OcgMessage)[0]).toMatchObject({ kind: "synchro" });
  });
  it("clears old reasons when cards leave or another card enters the slot", () => {
    const duel = tracker(1);
    const move = { type: M.MOVE, card: loc.code, from: { ...loc, location: L.EXTRA }, to: loc, reason: 0x40000 };
    duel.ingest(move as OcgMessage);
    duel.ingest({ type: M.MOVE, card: loc.code, from: loc, to: { ...loc, location: L.GRAVE } });
    expect(duel.ingest({ type: M.SPSUMMONING, ...loc })[0]).toMatchObject({ kind: "special" });
    duel.ingest(move as OcgMessage);
    expect(duel.ingest({ type: M.SPSUMMONING, ...loc, code: 456 })[0]).toMatchObject({ kind: "special" });
  });
  it("infers a hybrid Fusion/Pendulum summon only when leaving the extra deck", () => {
    const duel = tracker(0x1000041);
    duel.ingest({ type: M.MOVE, card: loc.code, from: { ...loc, location: L.EXTRA }, to: loc });
    expect(duel.ingest({ type: M.SPSUMMONING, ...loc })[0]).toMatchObject({ kind: "fusion" });
  });
  it.each([0x81, 0x1000001])("emits special for Ritual/Pendulum type %s without a summon reason", type => {
    for (const location of [L.GRAVE, L.HAND, L.EXTRA]) {
      const duel = tracker(type);
      duel.ingest({ type: M.MOVE, card: loc.code, from: { ...loc, location }, to: loc });
      expect(duel.ingest({ type: M.SPSUMMONING, ...loc })[0]).toMatchObject({ kind: "special" });
    }
    expect(tracker(type).ingest({ type: M.SPSUMMONING, ...loc })[0]).toMatchObject({ kind: "special" });
  });
  it.each(kinds)("emits special for type %s revived from the graveyard", (type) => {
    const duel = tracker(type | 1);
    duel.ingest({ type: M.MOVE, card: loc.code, from: { ...loc, location: L.GRAVE }, to: loc });
    expect(duel.ingest({ type: M.SPSUMMONING, ...loc })[0]).toMatchObject({ kind: "special" });
  });
  it.each([0, 0x40, 0x800])("does not infer Fusion when a generic reason %s is known", reason => {
    const duel = tracker(0x41);
    duel.ingest({ type: M.MOVE, card: loc.code, from: { ...loc, location: L.EXTRA }, to: loc, reason } as OcgMessage);
    expect(duel.ingest({ type: M.SPSUMMONING, ...loc })[0]).toMatchObject({ kind: "special" });
    expect(tracker(0x41).ingest({ type: M.SPSUMMONING, ...loc, reason } as OcgMessage)[0]).toMatchObject({ kind: "special" });
  });
  it("falls back for ordinary and unknown cards", () => {
    for (const type of [0, 1, 0x21]) {
      expect(tracker(type).ingest({ type: M.SPSUMMONING, ...loc })[0]).toMatchObject({ kind: "special" });
    }
    expect(tracker().ingest({ type: M.SPSUMMONING, ...loc, code: 456 })[0]).toMatchObject({ kind: "special" });
  });
  it("reports normal, flip and monster sets without treating spell sets as summons", () => {
    const duel = tracker(1);
    for (const [type, kind] of [[M.SUMMONING, "normal"], [M.FLIPSUMMONING, "flip"], [M.SET, "set"]] as const) {
      expect(duel.ingest({ type, ...loc })[0]).toMatchObject({ t: "summon", kind });
    }
    expect(duel.ingest({ type: M.SET, ...loc, location: L.SZONE })).toEqual([]);
  });
});
