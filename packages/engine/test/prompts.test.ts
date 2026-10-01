import { describe, expect, it } from "vitest";
import {
  OcgLocation,
  OcgMessageType,
  OcgOpCode,
  OcgPosition,
  OcgResponseType,
} from "ocgcore-wasm";
import type { OcgMessage } from "ocgcore-wasm";
import { SqlCardDb, type RawCard } from "../src/carddb.js";
import { translatePrompt, type PromptContext } from "../src/prompts.js";

const raw = (code: number, name: string, amount = 4): RawCard => ({
  code, alias: 0, setcode: 0n, type: 1 | 0x20, atk: 1000, def: 1000,
  level: amount, race: 1, attribute: 1, ot: 1, name, desc: `${name} effect`, strs: [`${name} effect`],
});

function context(): PromptContext {
  const db = new SqlCardDb();
  db.raw.set(100, raw(100, "Alpha"));
  db.raw.set(200, raw(200, "Beta", 8));
  db.raw.set(300, raw(300, "Gamma"));
  return {
    db,
    strings: { system: new Map(), victory: new Map(), counter: new Map([[7, "Spell Counters"]]), setname: new Map() },
    promptId: "p1",
    card: (loc) => ({
      uid: `${loc.controller}:${loc.location}:${loc.sequence}`,
      code: loc.code, owner: loc.controller, controller: loc.controller,
      location: loc.location === OcgLocation.REMOVED ? "banished" : loc.location === OcgLocation.GRAVE ? "grave" : "mzone",
      sequence: loc.sequence, position: "faceup", atk: 1000, def: 1000,
    }),
  };
}

const loc = (code: number, sequence = 0, controller: 0 | 1 = 0): any => ({
  code, controller, location: OcgLocation.MZONE, sequence, position: OcgPosition.FACEUP_ATTACK,
});

function translate(message: OcgMessage) {
  const result = translatePrompt(message, context());
  expect(result).toBeDefined();
  return result!;
}

describe("translatePrompt", () => {
  it("returns no decision for non-interactive engine messages", () => {
    expect(translatePrompt({ type: OcgMessageType.DRAW, player: 0, drawn: [] }, context())).toBeUndefined();
    expect(translatePrompt({ type: OcgMessageType.SELECT_YESNO, player: 2, description: 1n }, context())).toBeUndefined();
  });

  it("enumerates card choices and rejects malformed responses", () => {
    const translated = translate({
      type: OcgMessageType.SELECT_CARD, player: 0, can_cancel: true, min: 1, max: 2,
      selects: [loc(100, 0), loc(200, 1)],
    });
    expect(translated.prompt.kind).toBe("select_card");
    expect(translated.prompt.options.map((o) => o.label)).toEqual([
      "Alpha (Your Monster Zone 1)", "Beta (Your Monster Zone 2)", "Cancel selection",
    ]);
    expect(translated.respond(["1"])).toEqual({ type: OcgResponseType.SELECT_CARD, indicies: [1] });
    expect(translated.respond(["cancel"])).toEqual({ type: OcgResponseType.SELECT_CARD, indicies: null });
    expect(() => translated.respond(["0", "0"])).toThrow(/duplicate/);
    expect(() => translated.respond(["nope"])).toThrow(/unknown/);
  });

  it("uses card effect strings for effect prompts and preserves chain pass", () => {
    const effect = translate({
      type: OcgMessageType.SELECT_EFFECTYN, player: 0, ...loc(100), description: 100n * 16n,
    });
    expect(effect.prompt.text).toContain("Alpha effect");
    expect(effect.respond(["yes"])).toEqual({ type: OcgResponseType.SELECT_EFFECTYN, yes: true });

    const chain = translate({
      type: OcgMessageType.SELECT_CHAIN, player: 0, spe_count: 0, forced: false,
      hint_timing: 0 as any, hint_timing_other: 0 as any,
      selects: [{ ...loc(200), description: 200n * 16n, client_mode: 0 }],
    });
    expect(chain.prompt.options.at(-1)?.id).toBe("pass");
    expect(chain.respond(["pass"])).toEqual({ type: OcgResponseType.SELECT_CHAIN, index: null });
  });

  it("flattens idle and battle command menus without inventing actions", () => {
    const idle = translate({
      type: OcgMessageType.SELECT_IDLECMD, player: 0,
      summons: [loc(100)], special_summons: [], pos_changes: [], monster_sets: [], spell_sets: [], activates: [],
      to_bp: true, to_ep: true, shuffle: false,
    });
    expect(idle.prompt.options.map((o) => o.id)).toEqual(["summon:0", "to_bp", "to_ep"]);
    expect(idle.respond(["summon:0"])).toEqual({ type: OcgResponseType.SELECT_IDLECMD, action: 0, index: 0 });
    expect(idle.respond(["to_bp"])).toEqual({ type: OcgResponseType.SELECT_IDLECMD, action: 6, index: 0 });
    expect(() => idle.respond(["shuffle"])).toThrow(/unknown/);

    const battle = translate({
      type: OcgMessageType.SELECT_BATTLECMD, player: 0,
      chains: [], attacks: [{ ...loc(100), can_direct: true }], to_m2: true, to_ep: false,
    });
    expect(battle.respond(["attack:0"])).toEqual({ type: OcgResponseType.SELECT_BATTLECMD, action: 1, index: 0 });
    expect(battle.respond(["to_m2"])).toEqual({ type: OcgResponseType.SELECT_BATTLECMD, action: 2, index: 0 });
  });

  it("validates tribute values rather than only card count", () => {
    const translated = translate({
      type: OcgMessageType.SELECT_TRIBUTE, player: 0, can_cancel: false, min: 2, max: 2,
      selects: [
        { ...loc(100, 0), release_param: 2 },
        { ...loc(200, 1), release_param: 1 },
      ],
    });
    expect(translated.respond(["0"])).toEqual({ type: OcgResponseType.SELECT_TRIBUTE, indicies: [0] });
    expect(() => translated.respond(["1"])).toThrow(/tributes/);
    expect(() => translated.respond(["0", "1", "0"])).toThrow(/duplicate/);
  });

  it("validates exact and at-least sum modes with mandatory cards", () => {
    const exact = translate({
      type: OcgMessageType.SELECT_SUM, player: 0, select_max: 0, amount: 12, min: 1, max: 2,
      selects_must: [{ ...loc(100), amount: 4 }],
      selects: [{ ...loc(200, 1), amount: 8 }, { ...loc(300, 2), amount: 4 }],
    });
    expect(exact.prompt.text).toContain("Mandatory: Alpha");
    expect(exact.respond(["0"])).toEqual({ type: OcgResponseType.SELECT_SUM, indicies: [0] });
    expect(() => exact.respond(["1"])).toThrow(/sum/);

    const atleast = translate({
      type: OcgMessageType.SELECT_SUM, player: 0, select_max: 1, amount: 8, min: 1, max: 0,
      selects_must: [], selects: [{ ...loc(200), amount: 4 }, { ...loc(300, 1), amount: 4 }],
    });
    expect(atleast.respond(["0", "1"])).toEqual({ type: OcgResponseType.SELECT_SUM, indicies: [0, 1] });
  });

  it("expands counter amounts and returns one amount per offered card", () => {
    const translated = translate({
      type: OcgMessageType.SELECT_COUNTER, player: 0, counter_type: 7, count: 3,
      cards: [
        { ...loc(100), count: 2 },
        { ...loc(200, 1), count: 3 },
      ],
    });
    expect(translated.prompt.options.map((o) => o.id)).toEqual([
      "counter:0:1", "counter:0:2", "counter:1:1", "counter:1:2", "counter:1:3",
    ]);
    expect(translated.respond(["counter:0:2", "counter:1:1"])).toEqual({
      type: OcgResponseType.SELECT_COUNTER, counters: [2, 1],
    });
    expect(() => translated.respond(["counter:0:1", "counter:0:2"])).toThrow(/one counter amount/);
    expect(() => translated.respond(["counter:1:2"])).toThrow(/selected 2 counters/);
  });

  it("enumerates field places from the relative field mask", () => {
    const translated = translate({
      type: OcgMessageType.SELECT_PLACE, player: 0, count: 2,
      field_mask: (1 << 0) | (1 << 8) | (1 << 16),
    });
    expect(translated.prompt.options.map((o) => o.id)).toEqual([
      "place:0:4:1", "place:0:4:2", "place:0:4:3", "place:0:4:4", "place:0:4:5", "place:0:4:6",
      "place:0:8:1", "place:0:8:2", "place:0:8:3", "place:0:8:4", "place:0:8:5", "place:0:8:6", "place:0:8:7",
      "place:1:4:1", "place:1:4:2", "place:1:4:3", "place:1:4:4", "place:1:4:5", "place:1:4:6",
      "place:1:8:0", "place:1:8:1", "place:1:8:2", "place:1:8:3", "place:1:8:4", "place:1:8:5", "place:1:8:6", "place:1:8:7",
    ]);
    expect(translated.respond(["place:0:4:1", "place:1:8:7"])).toEqual({
      type: OcgResponseType.SELECT_PLACE,
      places: [{ player: 0, location: OcgLocation.MZONE, sequence: 1 }, { player: 1, location: OcgLocation.SZONE, sequence: 7 }],
    });
  });

  it("maps announcements, sorting and iterative select/unselect responses", () => {
    const number = translate({ type: OcgMessageType.ANNOUNCE_NUMBER, player: 0, options: [12n, 34n] });
    expect(number.prompt.options.map((o) => o.label)).toEqual(["Declare 12", "Declare 34"]);
    expect(number.respond(["1"])).toEqual({ type: OcgResponseType.ANNOUNCE_NUMBER, value: 1 });

    const attrib = translate({ type: OcgMessageType.ANNOUNCE_ATTRIB, player: 0, count: 2, available: (1 | 4) as any });
    expect(attrib.respond(["1", "4"])).toEqual({ type: OcgResponseType.ANNOUNCE_ATTRIB, attributes: [1, 4] });
    expect(() => attrib.respond(["1"])).toThrow(/expected 2-2/);

    const position = translate({ type: OcgMessageType.SELECT_POSITION, player: 0, code: 100, positions: (OcgPosition.FACEUP_ATTACK | OcgPosition.FACEUP_DEFENSE) as any });
    expect(position.respond([String(OcgPosition.FACEUP_DEFENSE)])).toEqual({ type: OcgResponseType.SELECT_POSITION, position: OcgPosition.FACEUP_DEFENSE });

    const disfield = translate({ type: OcgMessageType.SELECT_DISFIELD, player: 0, count: 1, field_mask: 0 });
    expect(disfield.respond(["place:0:4:0"])).toEqual({ type: OcgResponseType.SELECT_DISFIELD, places: [{ player: 0, location: OcgLocation.MZONE, sequence: 0 }] });

    const rps = translate({ type: OcgMessageType.ROCK_PAPER_SCISSORS, player: 0 });
    expect(rps.prompt.options.map((o) => o.label)).toEqual(["Scissors", "Rock", "Paper"]);
    expect(rps.respond(["2"])).toEqual({ type: OcgResponseType.ROCK_PAPER_SCISSORS, value: 2 });

    const sorted = translate({ type: OcgMessageType.SORT_CARD, player: 0, cards: [loc(100), loc(200, 1), loc(300, 2)] });
    expect(sorted.respond(["2", "0", "1"])).toEqual({ type: OcgResponseType.SORT_CARD, order: [1, 2, 0] });
    expect(sorted.respond(["keep"])).toEqual({ type: OcgResponseType.SORT_CARD, order: null });

    const unselect = translate({
      type: OcgMessageType.SELECT_UNSELECT_CARD, player: 0, can_finish: true, can_cancel: false,
      min: 1, max: 1, select_cards: [loc(100)], unselect_cards: [loc(200, 1)],
    });
    expect(unselect.respond(["select:0"])).toEqual({ type: OcgResponseType.SELECT_UNSELECT_CARD, index: 0 });
    expect(unselect.respond(["unselect:0"])).toEqual({ type: OcgResponseType.SELECT_UNSELECT_CARD, index: 1 });
    expect(unselect.respond(["finish"])).toEqual({ type: OcgResponseType.SELECT_UNSELECT_CARD, index: null });
  });

  it("enumerates cards matching announce-card opcodes", () => {
    const translated = translate({
      type: OcgMessageType.ANNOUNCE_CARD, player: 0,
      opcodes: [200n, OcgOpCode.ISCODE],
    });
    expect(translated.prompt.options.map((o) => o.id)).toEqual(["200"]);
    expect(translated.respond(["200"])).toEqual({ type: OcgResponseType.ANNOUNCE_CARD, card: 200 });
    expect(() => translated.respond(["100"])).toThrow(/unknown choice/);
  });
});
