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
      const lowerType = q.type.toLowerCase();
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
