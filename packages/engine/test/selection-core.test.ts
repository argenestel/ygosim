import { describe, expect, it } from "vitest";
import { generateLegalSelections, validateSelection } from "@ygosim/protocol";
import { controlledDuel, L, P } from "./helpers/controlled-duel.js";

describe("shared selection constraints with real card scripts", () => {
  it.each([
    { name: "two ordinary monsters", tributes: [69140098, 46986414], double: false },
    { name: "Kaiser Sea Horse alone", tributes: [17444133], double: true },
  ])("summons Blue-Eyes with $name", async ({ tributes, double }) => {
    const h = await controlledDuel([
      { code: 89631139, player: 0, location: L.HAND },
      ...tributes.map((code, sequence) => ({ code, player: 0 as const, location: L.MZONE, sequence, position: P.FACEUP_ATTACK })),
    ]);
    try {
      await h.until(p => p.player === 0 && p.prompt.kind === "idle");
      await h.answer(o => o.id.startsWith("summon:") && o.card?.code === 89631139);
      const pending = await h.until(p => p.prompt.kind === "select_tribute");
      const choices = pending.prompt.options.filter(o => o.card).map(o => o.id);
      expect(pending.prompt.constraints?.kind).toBe("tribute");
      expect(validateSelection(pending.prompt, choices).valid).toBe(true);
      expect(generateLegalSelections(pending.prompt).candidates).toContainEqual(choices);
      expect(() => h.duel.respond(pending.player, { promptId: "stale", choose: choices })).toThrow(/stale/);
      if (!double) {
        expect(validateSelection(pending.prompt, [choices[0]!]).valid).toBe(false);
        expect(() => h.duel.respond(pending.player, { promptId: pending.prompt.promptId, choose: [choices[0]!] })).toThrow(/tributes.*need at least 2/);
      }
      expect((await h.next()).prompt.promptId).toBe(pending.prompt.promptId);
      h.duel.respond(pending.player, { promptId: pending.prompt.promptId, choose: choices });
      await h.until(p => p.player === 0 && p.prompt.kind === "idle");
      expect(h.duel.stateFor(0).cards.some(c => c.code === 89631139 && c.location === "mzone")).toBe(true);
      for (const code of tributes) expect(h.duel.stateFor(0).cards.some(c => c.code === code && c.location === "grave")).toBe(true);
    } finally {
      h.duel.destroy();
    }
  });
});
