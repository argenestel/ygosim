import { describe, expect, it } from "vitest";
import createCore, { OcgDuelMode, OcgLocation, OcgMessageType, OcgPosition, OcgProcessResult, OcgQueryFlags, OcgResponseType } from "ocgcore-wasm";
import { loadCardDb, toOcgCard } from "../src/carddb.js";
import { makeScriptReader } from "../src/data.js";
import { adaptResponse } from "../src/response.js";
import { translatePrompt } from "../src/prompts.js";

function littleEndianInt16Bytes(words: number[]): number[] {
  const bytes = new Uint8Array(words.length * 2);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setInt16(index * 2, word, true));
  return [...bytes];
}

describe("adaptResponse", () => {
  it("packs even sort permutations into the wrapper's counter words", () => {
    const adapted = adaptResponse({ type: OcgResponseType.SORT_CARD, order: [2, 0, 1, 3] });
    expect(adapted).toEqual({ type: OcgResponseType.SELECT_COUNTER, counters: [2, 0x0301] });
    expect(littleEndianInt16Bytes((adapted as any).counters)).toEqual([2, 0, 1, 3]);
  });

  it("pads the final high byte for odd-length permutations", () => {
    const adapted = adaptResponse({ type: OcgResponseType.SORT_CARD, order: [1, 0, 2] });
    expect(adapted).toEqual({ type: OcgResponseType.SELECT_COUNTER, counters: [1, 2] });
    expect(littleEndianInt16Bytes((adapted as any).counters)).toEqual([1, 0, 2, 0]);
  });

  it("keeps the native sort sentinel and unrelated responses unchanged", () => {
    const sort = { type: OcgResponseType.SORT_CARD, order: null } as const;
    const yesNo = { type: OcgResponseType.SELECT_YESNO, yes: true } as const;
    expect(adaptResponse(sort)).toBe(sort);
    expect(adaptResponse(yesNo)).toBe(yesNo);
    expect(() => adaptResponse({ type: OcgResponseType.SORT_CARD, order: [128] })).toThrow(/int8/);
  });

  it("accepts an adapted sort permutation in the real core", async () => {
    const db = await loadCardDb();
    const core = await createCore({ sync: true });
    const errors: string[] = [];
    const handle = core.createDuel({
      flags: OcgDuelMode.MODE_MR5,
      seed: [1n, 2n, 3n, 4n],
      team1: { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 },
      team2: { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 },
      cardReader: (code) => db.raw.has(code) ? toOcgCard(db.raw.get(code)!) : null,
      scriptReader: makeScriptReader(),
      errorHandler: (_type, text) => errors.push(text),
    });
    if (!handle) throw new Error("failed to create core duel");
    try {
      for (const name of ["constant.lua", "utility.lua"]) {
        const script = makeScriptReader()(name);
        if (!script || !core.loadScript(handle, name, script)) throw new Error(`failed to load ${name}`);
      }
      const sortScript = `
        local e=Effect.GlobalEffect()
        e:SetType(EFFECT_TYPE_FIELD+EFFECT_TYPE_CONTINUOUS)
        e:SetCode(EVENT_STARTUP)
        e:SetOperation(function(e,tp)
          e:Reset()
          Duel.SortDecktop(tp,tp,3)
        end)
        Duel.RegisterEffect(e,0)
      `;
      expect(core.loadScript(handle, "test-sort.lua", sortScript)).toBe(true);
      const codes = [43096270, 69247929, 14898066];
      for (const team of [0, 1] as const) {
        for (let i = 0; i < 40; i++) {
          core.duelNewCard(handle, {
            team, duelist: 0, code: codes[i % codes.length], controller: team, location: OcgLocation.DECK,
            sequence: 0, position: OcgPosition.FACEDOWN_DEFENSE,
          });
        }
      }
      core.startDuel(handle);
      let sawSort = false;
      for (let attempt = 0; attempt < 20 && !sawSort; attempt++) {
        const status = core.duelProcess(handle);
        const messages = core.duelGetMessage(handle);
        expect(messages.some((message) => message.type === OcgMessageType.RETRY), `${messages.map((message) => String(message.type)).join(",")} errors=${errors.join(" | ")}`).toBe(false);
        const sort = messages.find((message) => message.type === OcgMessageType.SORT_CARD);
        if (!sort || sort.type !== OcgMessageType.SORT_CARD) {
          if (status === OcgProcessResult.END) break;
          continue;
        }
        sawSort = true;
        expect(sort.cards).toHaveLength(3);
        const translated = translatePrompt(sort, {
          db,
          strings: { system: new Map(), victory: new Map(), counter: new Map(), setname: new Map() },
          promptId: "sort-test",
          card: (loc) => ({
            uid: `${loc.controller}:${loc.location}:${loc.sequence}`,
            code: loc.code,
            owner: loc.controller,
            controller: loc.controller,
            location: "deck",
            sequence: loc.sequence,
            position: "facedown",
          }),
        });
        expect(translated).toBeDefined();
        const response = translated!.respond(["2", "0", "1"]);
        expect(response).toEqual({ type: OcgResponseType.SORT_CARD, order: [1, 2, 0] });
        const offered = sort.cards.map((card) => card.code);
        core.duelSetResponse(handle, adaptResponse(response));
        const after = core.duelProcess(handle);
        const afterMessages = core.duelGetMessage(handle);
        expect(afterMessages.some((message) => message.type === OcgMessageType.RETRY)).toBe(false);
        expect(after).not.toBe(OcgProcessResult.END);
        const rows = core.duelQueryLocation(handle, {
          controller: sort.player as 0 | 1,
          location: OcgLocation.DECK,
          flags: OcgQueryFlags.CODE,
        });
        // Query order is bottom-to-top; SortDecktop's visible order is the reverse.
        expect(rows.slice(-3).reverse().map((row) => row?.code)).toEqual([offered[2], offered[0], offered[1]]);
      }
      expect(errors).toEqual([]);
      expect(sawSort).toBe(true);
    } finally {
      core.destroyDuel(handle);
    }
  }, 30_000);
});
