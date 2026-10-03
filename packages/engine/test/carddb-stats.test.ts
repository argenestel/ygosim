import { describe, expect, it } from "vitest";
import { loadCardDb, toCardData, type RawCard } from "../src/carddb.js";

const raw = (overrides: Partial<RawCard> = {}): RawCard => ({
  code: 1, alias: 0, setcode: 0n, type: 1, atk: 3000, def: 600, level: 11,
  race: 256, attribute: 16, ot: 2, name: "Test monster", desc: "", strs: [], ...overrides,
});

describe("public card stats", () => {
  it("omits the database's -2 unknown-stat sentinel", () => {
    expect(toCardData(raw({ atk: -2, def: -2 }))).toMatchObject({ code: 1, name: "Test monster", atkUnknown: true, defUnknown: true });
    expect(toCardData(raw({ atk: -2, def: -2 }))).not.toHaveProperty("atk");
    expect(toCardData(raw({ atk: -2, def: -2 }))).not.toHaveProperty("def");
  });

  it("keeps ordinary attack and defense values in their protocol fields", () => {
    expect(toCardData(raw())).toMatchObject({ atk: 3000, def: 600 });
  });

  it("marks Zoodiac Broadbull's real CDB question-mark stats", async () => {
    const card = (await loadCardDb()).get(85115440);
    expect(card).toMatchObject({ name: "Zoodiac Broadbull", atkUnknown: true, defUnknown: true });
    expect(card).not.toHaveProperty("atk");
    expect(card).not.toHaveProperty("def");
  });
});
