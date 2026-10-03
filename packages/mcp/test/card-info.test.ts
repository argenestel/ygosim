import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardData } from "@ygosim/protocol";
import { Session } from "../src/tools.js";

afterEach(() => vi.unstubAllGlobals());

describe("card_info stat rendering", () => {
  it.each([
    { name: "legacy -2 unknown stats", atk: -2, def: -2 },
    { name: "protocol unknown-stat flags", atkUnknown: true, defUnknown: true },
  ])("renders $name as question marks", async (stats) => {
    const card: CardData = { code: 123, name: "Unknown Being", desc: "", type: ["Monster", "Effect"], ...stats, imageUrl: "" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(card), { status: 200, headers: { "content-type": "application/json" } })));
    const session = new Session({ baseUrl: "http://example.test", name: "test" });
    const tool = session.tools().find((candidate) => candidate.name === "card_info");
    if (!tool) throw new Error("card_info tool missing");
    const output = await tool.run({ code: card.code });
    expect(output).toContain("ATK ? / DEF ?");
    expect(output).not.toContain("ATK -2");
    expect(output).not.toContain("DEF -2");
  });
});
