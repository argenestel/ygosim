import { describe, expect, it } from "vitest";
import { OcgMessageType as M } from "ocgcore-wasm";
import { SqlCardDb } from "../src/carddb.js";
import { DuelTracker } from "../src/state.js";

const strings = { system: new Map(), victory: new Map(), counter: new Map(), setname: new Map() };

describe("LP cost event translation", () => {
  it("emits pay_lp while applying the cost to the player's LP", () => {
    const tracker = new DuelTracker(new SqlCardDb(), strings, 8000, 0);

    expect(tracker.ingest({ type: M.PAY_LPCOST, player: 0, amount: 1000 })).toEqual([
      { t: "pay_lp", player: 0, amount: 1000, lp: 7000 },
    ]);
    expect(tracker.stateFor(0).lp).toEqual([7000, 8000]);
  });
});
