import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createDuel, parseYdk } from "../src/index.js";
import { DuelTracker } from "../src/state.js";
const deck = () => parseYdk(readFileSync(new URL("./fixtures/vanilla-dragons.ydk", import.meta.url), "utf8"));
describe("duel lifecycle", () => {
  it("renders core prompts without building full state snapshots", async () => {
    const d = deck();
    const duel = await createDuel({ decks: [d, d], seed: 42 });
    const snapshots = vi.spyOn(DuelTracker.prototype, "stateFor");
    try {
      const step = await duel.step();
      expect(step.pending).toBeDefined();
      expect(snapshots).not.toHaveBeenCalled();
    } finally { snapshots.mockRestore(); duel.destroy(); }
  });
  it("validates deck and creation settings before starting the core", async () => {
    const d = deck();
    await expect(createDuel({decks:[d,d], masterRule: 6})).rejects.toThrow("masterRule");
    await expect(createDuel({decks:[d,d], startingLp: 0})).rejects.toThrow("startingLp");
    await expect(createDuel({decks:[{...d, main:[89631139]}, d]})).rejects.toThrow("Deck sizes");
    await expect(createDuel({decks:[{...d, main:Array(40).fill(89631139)},d]})).rejects.toThrow("three copies");
  });
  it("supports an enumerable first-turn choice without changing the duel ID", async () => {
    const d = deck(); const duel = await createDuel({decks:[d,d], seed:10, chooseFirstTurn:true});
    try {
      const id = duel.stateFor(0).duelId;
      const first = await duel.step(); const pending = first.pending!;
      expect(pending.prompt.kind).toBe("first_turn"); expect(pending.prompt.options.map(o=>o.id)).toEqual(["0","1"]);
      expect(() => duel.respond(1,{promptId:pending.prompt.promptId,choose:["1"]})).toThrow("Invalid");
      duel.respond(0,{promptId:pending.prompt.promptId,choose:["1"]});
      const step = await duel.step(); expect(step.pending).toBeDefined();
      expect(duel.stateFor(0).duelId).toBe(id); expect(duel.stateFor(0).turnPlayer).toBe(1);
      const again = await duel.step(); expect(again.events).toEqual([]); expect(again.pending).toEqual(step.pending);
      expect(() => duel.respond(step.pending!.player,{promptId:pending.prompt.promptId,choose:["1"]})).toThrow("stale");
      expect(() => duel.respond(step.pending!.player,{promptId:step.pending!.prompt.promptId,choose:["bogus"]})).toThrow();
    } finally { duel.destroy(); }
    duel.destroy(); await expect(duel.step()).rejects.toThrow("destroyed"); expect(()=>duel.stateFor(0)).toThrow("destroyed");
  });
});
