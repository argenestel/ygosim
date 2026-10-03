import { describe, expect, it } from "vitest";
import { CardCache } from "../src/cards.js";
import { collectCodes, formatCardDataStats, formatStat, renderEvent, renderState } from "../src/render.js";

describe("renderEvent", () => {
  it("renders LP payments as costs with the resulting LP", () => {
    const rendered = renderEvent({ t: "pay_lp", player: 0, amount: 300, lp: 7700 }, 0, new CardCache("http://127.0.0.1:1"));

    expect(rendered).toBe("You paid 300 LP (cost) → 7700");
  });
});

describe("render stats and chain context", () => {
  it("renders unknown attack/defense values as question marks", () => {
    expect(formatStat(-2)).toBe("?");
    expect(formatCardDataStats({ atk: -2, def: 600 })).toBe("ATK ? / DEF 600");
    expect(formatCardDataStats({ atkUnknown: true, defUnknown: true })).toBe("ATK ? / DEF ?");
    expect(formatCardDataStats({ defUnknown: true })).toBe("DEF ?");
    const cards = new CardCache("http://127.0.0.1:1");
    const ref = { uid: "n", code: 1, owner: 0 as const, controller: 0 as const, location: "mzone" as const, sequence: 0, position: "atk" as const, atk: 3000, def: 600 };
    const defense = { ...ref, uid: "d", sequence: 1, position: "def" as const };
    const state = { duelId: "d", turn: 1, turnPlayer: 0 as const, phase: "main1" as const, lp: [8000, 8000] as [number, number], you: 0 as const, cards: [ref, defense], chain: [] };
    const rendered = renderState(state, cards);
    expect(rendered.match(/ATK 3000 \/ DEF 600/g)).toHaveLength(2);
  });

  it("includes chain target names and prefetches their codes", () => {
    const cards = new CardCache("http://127.0.0.1:1");
    const cache = (cards as unknown as { cache: Map<number, { code: number; name: string }> }).cache;
    cache.set(100, { code: 100, name: "Effect Card" });
    cache.set(200, { code: 200, name: "Target Card" });
    const target = { uid: "target", code: 200, owner: 1 as const, controller: 1 as const, location: "mzone" as const, sequence: 0, position: "atk" as const };
    const state = { duelId: "d", turn: 1, turnPlayer: 0 as const, phase: "main1" as const, lp: [8000, 8000] as [number, number], you: 0 as const,
      cards: [target], chain: [{ card: { uid: "effect", code: 100, owner: 0 as const, controller: 0 as const, location: "mzone" as const, sequence: 0, position: "atk" as const }, desc: "Effect", targets: [target] }] };
    expect(renderState(state, cards)).toContain("targets: Target Card");
    expect(collectCodes(state)).toEqual([200, 100, 200]);
  });
});
