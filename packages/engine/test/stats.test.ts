import { describe, expect, it } from "vitest";
import { L, P, controlledDuel } from "./helpers/controlled-duel.js";

describe("core card stat translation", () => {
  it("keeps Nibiru's ATK/DEF fields stable when changing battle position", async () => {
    const h = await controlledDuel([{ code: 27204311, player: 0, location: L.MZONE, position: P.FACEUP_ATTACK }]);
    try {
      const idle = await h.until((pending) => pending.player === 0 && pending.prompt.kind === "idle");
      const initial = h.duel.stateFor(0).cards.find((card) => card.code === 27204311);
      expect(initial).toMatchObject({ position: "atk", atk: 3000, def: 600 });

      const change = idle.prompt.options.find((option) => option.card?.code === 27204311 && /Change .*DEF position/.test(option.label));
      expect(change).toBeDefined();
      h.duel.respond(idle.player, { promptId: idle.prompt.promptId, choose: [change!.id] });
      await h.next();

      const defense = h.duel.stateFor(0).cards.find((card) => card.code === 27204311);
      expect(defense).toMatchObject({ position: "def", atk: 3000, def: 600 });
    } finally {
      h.duel.destroy();
    }
  });
});
