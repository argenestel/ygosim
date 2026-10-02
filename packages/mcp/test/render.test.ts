import { describe, expect, it } from "vitest";
import { CardCache } from "../src/cards.js";
import { renderEvent } from "../src/render.js";

describe("renderEvent", () => {
  it("renders LP payments as costs with the resulting LP", () => {
    const rendered = renderEvent({ t: "pay_lp", player: 0, amount: 300, lp: 7700 }, 0, new CardCache("http://127.0.0.1:1"));

    expect(rendered).toBe("You paid 300 LP (cost) → 7700");
  });
});
