import { describe, it, expect, beforeEach } from "vitest";
import type { CardData, CardDb } from "@ygosim/protocol";

// Mock card database for testing
class MockCardDb implements CardDb {
  private cards: Map<number, CardData> = new Map();

  constructor() {
    // Add some test cards
    this.cards.set(1, {
      code: 1,
      name: "Blue Eyes White Dragon",
      desc: "A legendary dragon",
      type: ["Monster", "Normal"],
      attribute: "LIGHT",
      race: "Dragon",
      level: 8,
      atk: 3000,
      def: 2500,
      imageUrl: "https://example.com/1.jpg",
    });

    this.cards.set(2, {
      code: 2,
      name: "Dark Magician",
      desc: "The ultimate wizard",
      type: ["Monster", "Spellcaster"],
      attribute: "DARK",
      race: "Spellcaster",
      level: 7,
      atk: 2500,
      def: 2100,
      imageUrl: "https://example.com/2.jpg",
    });

    this.cards.set(3, {
      code: 3,
      name: "Monster Reborn",
      desc: "Resurrect a monster",
      type: ["Spell", "Quick-Play"],
      imageUrl: "https://example.com/3.jpg",
    });

    this.cards.set(4, {
      code: 4,
      name: "Pot of Greed",
      desc: "Draw two cards",
      type: ["Spell"],
      imageUrl: "https://example.com/4.jpg",
    });
  }

  get(code: number): CardData | undefined {
    return this.cards.get(code);
  }

  search(q: { name?: string; type?: string; limit?: number }): CardData[] {
    let results = Array.from(this.cards.values());

    if (q.name) {
      const lowerName = q.name.toLowerCase();
      results = results.filter(c => c.name.toLowerCase().includes(lowerName));
    }

    if (q.type) {
      const lowerType = q.type?.toLowerCase();
      results = results.filter(c => c.type.some(t => t.toLowerCase() === lowerType));
    }

    const limit = q.limit ?? 50;
    return results.slice(0, limit);
  }
}

describe("Card Browser API", () => {
  let db: CardDb;

  beforeEach(() => {
    db = new MockCardDb();
  });

  it("should search cards by name", () => {
    const results = db.search({ name: "Blue Eyes", limit: 10 });
    expect(results.length).toBe(1);
    expect(results[0].code).toBe(1);
    expect(results[0].name).toBe("Blue Eyes White Dragon");
  });

  it("should search cards by type (exact match)", () => {
    const results = db.search({ type: "Spell", limit: 10 });
    expect(results.length).toBe(2);
    expect(results.map(c => c.code)).toContain(3);
    expect(results.map(c => c.code)).toContain(4);
  });

  it("should get single card by code", () => {
    const card = db.get(1);
    expect(card).toBeDefined();
    expect(card?.name).toBe("Blue Eyes White Dragon");
  });

  it("should return undefined for unknown cards", () => {
    const card = db.get(99999);
    expect(card).toBeUndefined();
  });

  it("should support case-insensitive search", () => {
    const results = db.search({ name: "blue eyes", limit: 10 });
    expect(results.length).toBe(1);
    expect(results[0].code).toBe(1);
  });

  it("should limit results", () => {
    const results = db.search({ limit: 1 });
    expect(results.length).toBe(1);
  });

  it("should return cards with attributes and levels", () => {
    const card = db.get(1);
    expect(card?.attribute).toBe("LIGHT");
    expect(card?.level).toBe(8);
    expect(card?.atk).toBe(3000);
    expect(card?.def).toBe(2500);
    expect(card?.race).toBe("Dragon");
  });
});

describe("Card Browser HTTP pagination", () => {
  const cards: CardData[] = Array.from({ length: 523 }, (_, i) => ({
    code: i + 1, name: `Trap ${String(i).padStart(4, "0")}`, desc: "Test card",
    imageUrl: "", type: ["Trap"], attribute: i % 2 ? "DARK" : "LIGHT", level: i % 2 ? 4 : 8,
  }));
  const db: CardDb = {
    get: code => cards.find(card => card.code === code),
    search: q => cards.filter(card => (!q.name || card.name.includes(q.name))
      && (!q.type || card.type.some(type => type.toLowerCase() === q.type?.toLowerCase())))
      .slice(0, q.limit ?? 50),
  };

  it("counts all matches and pages beyond the first 200 without gaps", async () => {
    const { buildApi } = await import("../src/server.js");
    const { Lobby } = await import("../src/lobby.js");
    const app = buildApi(new Lobby(async () => { throw new Error("unused"); }), () => db, () => null, async () => db);
    const codes: number[] = [];
    for (let offset = 0; offset < cards.length; offset += 200) {
      const response = await app.request(`/api/cards?kind=trap&offset=${offset}&limit=200`);
      const body = await response.json();
      expect(body.total).toBe(523);
      codes.push(...body.cards.map((card: CardData) => card.code));
    }
    expect(codes).toEqual(cards.map(card => card.code));
    const beyond = await (await app.request("/api/cards?kind=trap&offset=523")).json();
    expect(beyond).toEqual({ total: 523, cards: [] });
    const filtered = await (await app.request("/api/cards?kind=trap&attribute=LIGHT&level=8&offset=200&limit=100")).json();
    expect(filtered.total).toBe(262);
    expect(filtered.cards).toEqual(cards.filter(card => card.attribute === "LIGHT").slice(200, 300));
  });
});
