import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deck } from "@ygosim/protocol";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { OcgDuelMode, type OcgDuelOptionsSync } from "ocgcore-wasm";
import { createDuel } from "../src/index.js";
import { loadCardDb, SqlCardDb } from "../src/carddb.js";
import { dataDir } from "../src/data.js";
import { getBanlist, listFormats, validateDeck } from "../src/formats.js";
import { parseYdk } from "../src/ydk.js";

const coreCalls = vi.hoisted(() => [] as OcgDuelOptionsSync[]);
vi.mock("ocgcore-wasm", async importOriginal => {
  const actual = await importOriginal<typeof import("ocgcore-wasm")>();
  return { ...actual, default: async () => {
    const core = await actual.default({ sync: true });
    return { ...core, createDuel: (options: OcgDuelOptionsSync) => {
      coreCalls.push(options);
      return core.createDuel(options);
    } };
  } };
});

const source = dataDir();
const originalData = process.env.YGOSIM_DATA;
let root: string;
let db: SqlCardDb;
const fixture = (name = "vanilla-dragons") => parseYdk(readFileSync(new URL(`../decks/${name}.ydk`, import.meta.url), "utf8"));
const withCards = (...cards: number[]): Deck => {
  const deck = fixture();
  deck.main.splice(0, cards.length, ...cards);
  return deck;
};

beforeAll(async () => {
  db = await loadCardDb();
  root = mkdtempSync(join(tmpdir(), "ygosim-formats-"));
  symlinkSync(join(source, "CardScripts"), join(root, "CardScripts"), "dir");
  mkdirSync(join(root, "LFLists", "history"), { recursive: true });
  // Controlled lists: these test parser behavior, not today's upstream limits.
  writeFileSync(join(root, "LFLists", "2026-06-tcg.lflist.conf"), "!2026.06 TCG\n55144522 1\n");
  writeFileSync(join(root, "LFLists", "2026-07-tcg.lflist.conf"), "\uFEFF!2026.07 TCG\r\n# Forbidden\r\n55144522 0 --Pot of Greed\r\n89631139 1 #Blue-Eyes\r\n53129443 2\r\n");
  writeFileSync(join(root, "LFLists", "history", "OCG.lflist.conf"), "!2026.04 OCG\n55144522 1\n");
  writeFileSync(join(root, "LFLists", "OCG.new.lflist.conf"), "!2026.10 OCG\n55144522 0\n89631139 1\n53129443 2\n");
  const whitelist = [...new Set([...fixture().main, ...fixture("vanilla-sea").main])].map(code => `${code} 3`).join("\n");
  for (const name of ["GOAT", "Edison"]) writeFileSync(join(root, "LFLists", `${name}.lflist.conf`), `!${name} Whitelist\n$whitelist\n${whitelist}\n55144522 1\n`);
  writeFileSync(join(root, "LFLists", "Speed.lflist.conf"), "!Speed Duel\n55144522 0\n");
  process.env.YGOSIM_DATA = root;
});

afterAll(() => {
  if (originalData === undefined) delete process.env.YGOSIM_DATA;
  else process.env.YGOSIM_DATA = originalData;
  rmSync(root, { recursive: true, force: true });
});

describe("format registry and cached LFLists parsing", () => {
  it("provides all seven formats with valid independent snapshots", () => {
    const formats = listFormats();
    expect(formats.map(format => format.id)).toEqual(["tcg", "ocg", "traditional", "unlimited", "goat", "edison", "speed"]);
    for (const format of formats) {
      expect(format.masterRule).toBeGreaterThanOrEqual(1);
      expect(format.masterRule).toBeLessThanOrEqual(5);
      expect(format.startingLp).toBeGreaterThan(0);
      expect(format.startingHand).toBeGreaterThan(0);
      expect(format.drawPerTurn).toBe(1);
      expect(format.deck.mainMin).toBeLessThanOrEqual(format.deck.mainMax);
      expect(format.deck.extraMax).toBeGreaterThanOrEqual(0);
      expect(format.deck.sideMax).toBeGreaterThanOrEqual(0);
    }
    formats[0].deck.mainMin = 1;
    expect(listFormats()[0].deck.mainMin).toBe(40);
    expect(formats.find(format => format.id === "speed")).toMatchObject({ startingLp: 4000, startingHand: 4, deck: { mainMin: 20, mainMax: 30, extraMax: 5, sideMax: 6 } });
    expect(formats.find(format => format.id === "goat")).toMatchObject({ masterRule: 1, whitelist: true });
    expect(formats.find(format => format.id === "edison")).toMatchObject({ masterRule: 1, whitelist: true });
  });

  it("selects newest filenames and falls back to dates in headers", () => {
    expect(getBanlist("tcg")).toBeInstanceOf(Map);
    expect(getBanlist("tcg")?.get(55144522)).toBe(0);
    expect(getBanlist("tcg")?.get(89631139)).toBe(1);
    expect(getBanlist("tcg")?.get(53129443)).toBe(2);
    expect(getBanlist("ocg")?.get(55144522)).toBe(0);
    expect(listFormats().find(format => format.id === "ocg")?.banlist).toBe("2026.10 OCG");
    expect(listFormats().find(format => format.id === "traditional")?.banlist).toBe("2026.07 TCG");
    expect(getBanlist("unknown")).toBeNull();
    expect(getBanlist("unlimited")).toBeNull();
  });

  it("parses once and protects cached restrictions from callers", () => {
    getBanlist("tcg")!.set(55144522, 2);
    writeFileSync(join(root, "LFLists", "2026-07-tcg.lflist.conf"), "!2026.07 TCG\n55144522 2\n");
    expect(getBanlist("tcg")?.get(55144522)).toBe(0);
  });
});

describe("deck validation", () => {
  it.each(["tcg", "ocg", "traditional", "unlimited", "goat", "edison"])("accepts both sample decks under %s with fixture lists", format => {
    for (const name of ["vanilla-dragons", "vanilla-sea"]) expect(validateDeck(fixture(name), format, db)).toEqual({ ok: true, errors: [], format });
  });

  it("accepts Black Luster Soldier in the main deck with SQL and protocol databases", () => {
    expect(db.raw.get(5405694)!.type & 0x80).not.toBe(0);
    const publicDb = { get: db.get.bind(db), search: db.search.bind(db) };
    for (const cardDb of [db, publicDb]) {
      expect(validateDeck(withCards(5405694), "unlimited", cardDb)).toEqual({ ok: true, errors: [], format: "unlimited" });
      const deck = fixture(); deck.extra = [5405694];
      expect(validateDeck(deck, "unlimited", cardDb).errors).toContain("Invalid extra deck card: Black Luster Soldier");
    }
  });

  it("accepts main-deck Pendulum monsters and rejects them in the extra deck", () => {
    const pendulum = [...db.raw.values()].find(card => card.type & 0x1000000 && !(card.type & (0x40 | 0x2000 | 0x800000 | 0x4000000)))!;
    const publicDb = { get: db.get.bind(db), search: db.search.bind(db) };
    for (const cardDb of [db, publicDb]) {
      expect(validateDeck(withCards(pendulum.code), "unlimited", cardDb).ok).toBe(true);
      const deck = fixture(); deck.extra = [pendulum.code];
      expect(validateDeck(deck, "unlimited", cardDb).errors).toContain(`Invalid extra deck card: ${pendulum.name}`);
    }
  });

  it("accepts a Speed Duel sized deck", () => {
    const deck = fixture(); deck.main = deck.main.slice(0, 20);
    expect(validateDeck(deck, "speed", db).ok).toBe(true);
  });

  it("returns named forbidden and limited errors", () => {
    expect(validateDeck(withCards(55144522), "tcg", db).errors).toContain("Pot of Greed is Forbidden in TCG");
    expect(validateDeck(withCards(89631139, 89631139), "tcg", db).errors).toContain("Blue-Eyes White Dragon exceeds limit 1 (2 in deck)");
  });

  it("counts copies across main, extra and side", () => {
    const deck = withCards(89631139); deck.side = [89631139];
    expect(validateDeck(deck, "ocg", db).errors).toContain("Blue-Eyes White Dragon exceeds limit 1 (2 in deck)");
    const semi = withCards(53129443); // Fixture already contains two Dark Holes.
    expect(validateDeck(semi, "tcg", db).errors).toContain("Dark Hole exceeds limit 2 (3 in deck)");
    expect(validateDeck(withCards(89631139, 89631139, 89631139, 89631139), "unlimited", db).errors).toContain("Blue-Eyes White Dragon exceeds limit 3 (4 in deck)");
  });

  it("groups alternate passcodes with their canonical alias", () => {
    const aliasDb = new SqlCardDb();
    for (const [code, card] of db.raw) aliasDb.raw.set(code, card);
    aliasDb.raw.set(99999999, { ...db.raw.get(89631139)!, code: 99999999, alias: 89631139 });
    expect(validateDeck(withCards(89631139, 99999999), "tcg", aliasDb).errors).toContain("Blue-Eyes White Dragon exceeds limit 1 (2 in deck)");
    expect(validateDeck(withCards(89631139, 99999999, 99999999, 99999999), "unlimited", aliasDb).ok).toBe(false);
  });

  it("treats forbidden TCG cards as limited in Traditional", () => {
    expect(validateDeck(withCards(55144522), "traditional", db).ok).toBe(true);
    expect(validateDeck(withCards(55144522, 55144522), "traditional", db).errors).toContain("Pot of Greed exceeds limit 1 (2 in deck)");
    expect(getBanlist("traditional")?.get(55144522)).toBe(0);
  });

  it.each(["goat", "edison"])("enforces %s membership and whitelist restrictions including limit 3", format => {
    expect(getBanlist(format)?.has(fixture().main[0])).toBe(false);
    expect(validateDeck(fixture(), format, db).ok).toBe(true);
    expect(validateDeck(withCards(89631139), format, db).errors).toContain(`Blue-Eyes White Dragon is not legal in ${format === "goat" ? "GOAT" : "Edison"} (not on whitelist)`);
    expect(validateDeck(withCards(55144522, 55144522), format, db).errors).toContain("Pot of Greed exceeds limit 1 (2 in deck)");
  });

  it("reports invalid format, all size bounds and unknown passcodes", () => {
    expect(validateDeck(fixture(), "unknown", db)).toEqual({ ok: false, errors: ["Invalid format: unknown"], format: "unknown" });
    expect(validateDeck({ main: [], extra: Array(16).fill(58528964), side: Array(16).fill(89631139) }, "unlimited", db).errors.join("; ")).toMatch(/Main deck.*Extra deck.*Side deck/);
    expect(validateDeck(withCards(999999999), "unlimited", db).errors).toContain("Unknown card passcode 999999999");
    const huge = fixture(); huge.main = Array(61).fill(89631139);
    expect(validateDeck(huge, "unlimited", db).errors[0]).toContain("40–60");
    expect(validateDeck(fixture(), "speed", db).errors[0]).toContain("20–30");
  });

  it("rejects tokens and Extra Deck types in the wrong deck zones", () => {
    const token = [...db.raw.values()].find(card => card.type & 0x4000)!;
    expect(validateDeck(withCards(token.code), "unlimited", db).errors.join("; ")).toContain("Tokens cannot be included");
    for (const type of [0x40, 0x2000, 0x800000, 0x4000000]) {
      const card = [...db.raw.values()].find(card => card.type & 1 && card.type & type && !(card.type & 0x4000))!;
      expect(validateDeck(withCards(card.code), "unlimited", db).errors).toContain(`Invalid main deck card: ${card.name}`);
      const deck = fixture(); deck.extra = [card.code];
      expect(validateDeck(deck, "unlimited", db).ok).toBe(true);
    }
    const deck = fixture(); deck.extra = [89631139];
    expect(validateDeck(deck, "unlimited", db).errors).toContain("Invalid extra deck card: Blue-Eyes White Dragon");
    const ritualSpell = [...db.raw.values()].find(card => card.type & 2 && card.type & 0x80)!;
    expect(validateDeck(withCards(ritualSpell.code), "unlimited", db).ok).toBe(true);
  });

  it("supports protocol CardDb implementations without SQL metadata", () => {
    const publicDb = { get: db.get.bind(db), search: db.search.bind(db) };
    expect(validateDeck(fixture(), "unlimited", publicDb).ok).toBe(true);
    expect(validateDeck(withCards(58528964), "unlimited", publicDb).errors.join("; ")).toContain("Invalid main deck card");
  });
});

describe("missing and malformed list handling", () => {
  it("fails closed for missing, malformed and non-whitelist historical lists", async () => {
    const missing = mkdtempSync(join(tmpdir(), "ygosim-no-lists-"));
    symlinkSync(join(source, "CardScripts"), join(missing, "CardScripts"), "dir");
    process.env.YGOSIM_DATA = missing;
    try {
      vi.resetModules();
      const formats = await import("../src/formats.js");
      expect(formats.getBanlist("tcg")).toBeNull();
      expect(formats.validateDeck(fixture(), "tcg", db).errors.join("; ")).toContain("Ban list unavailable");
      expect(formats.validateDeck(fixture(), "goat", db).ok).toBe(false);
      expect(formats.validateDeck(fixture(), "unlimited", db).ok).toBe(true);
      mkdirSync(join(missing, "LFLists"));
      writeFileSync(join(missing, "LFLists", "TCG.lflist.conf"), "!2026.07 TCG\n55144522 nope\n");
      writeFileSync(join(missing, "LFLists", "GOAT.lflist.conf"), "!GOAT\n55144522 1\n");
      vi.resetModules();
      const malformed = await import("../src/formats.js");
      expect(malformed.getBanlist("tcg")).toBeNull();
      expect(malformed.validateDeck(fixture(), "goat", db).errors.join("; ")).toContain("missing $whitelist");
    } finally {
      process.env.YGOSIM_DATA = root;
      rmSync(missing, { recursive: true, force: true });
    }
  });
});

describe("format-aware real WASM duel creation", () => {
  it.each(["tcg", "ocg", "traditional", "unlimited", "goat", "edison", "speed"])("applies %s settings and creates a playable duel", async format => {
    const deck = fixture();
    if (format === "speed") deck.main = deck.main.slice(0, 20);
    const duel = await createDuel({ decks: [deck, deck], format, startingLp: 123, masterRule: 3, seed: 42 });
    try {
      const expectedRule = format === "goat" || format === "edison" ? OcgDuelMode.MODE_MR1 : OcgDuelMode.MODE_MR5;
      const options = coreCalls.at(-1)!;
      expect(options.flags).toBe(format === "speed" ? expectedRule | OcgDuelMode.MODE_SPEED : expectedRule);
      expect(options.team1).toEqual({ startingLP: format === "speed" ? 4000 : 8000, startingDrawCount: format === "speed" ? 4 : 5, drawCountPerTurn: 1 });
      expect(options.team2).toEqual(options.team1);
      expect(duel.stateFor(0).lp).toEqual(format === "speed" ? [4000, 4000] : [8000, 8000]);
      expect((await duel.step()).pending).toBeDefined();
      // MR1 includes a draw on the starting player's first turn.
      expect(duel.stateFor(0).cards.filter(card => card.controller === 0 && card.location === "hand")).toHaveLength(format === "speed" ? 4 : format === "goat" || format === "edison" ? 6 : 5);
    } finally { duel.destroy(); }
  });

  it("rejects an unknown format and named deck violations before core creation", async () => {
    const count = coreCalls.length;
    const deck = fixture();
    await expect(createDuel({ decks: [deck, deck], format: "unknown" })).rejects.toThrow("Unknown format: unknown");
    await expect(createDuel({ decks: [withCards(55144522), deck], format: "tcg" })).rejects.toThrow("Pot of Greed is Forbidden in TCG");
    expect(coreCalls).toHaveLength(count);
  });

  it("applies format settings when first turn is chosen later", async () => {
    const deck = fixture(); deck.main = deck.main.slice(0, 20);
    const duel = await createDuel({ decks: [deck, deck], format: "speed", chooseFirstTurn: true, seed: 7 });
    try {
      expect(duel.stateFor(0).lp).toEqual([4000, 4000]);
      const step = await duel.step();
      duel.respond(0, { promptId: step.pending!.prompt.promptId, choose: ["1"] });
      expect(coreCalls.at(-1)!.team1.startingDrawCount).toBe(4);
      expect((await duel.step()).pending).toBeDefined();
    } finally { duel.destroy(); }
  });
});

// Use the original data directory, never the synthetic parser fixtures above.
describe.skipIf(!existsSync(join(source, "LFLists")))("real LFLists from ProjectIgnis", () => {
  beforeEach(() => { process.env.YGOSIM_DATA = source; });
  afterEach(() => { process.env.YGOSIM_DATA = root; });

  it("loads actual TCG, OCG and GOAT lists and reports Edison availability", () => {
    const formats = listFormats();
    for (const id of ["tcg", "ocg", "goat", "edison"] as const) {
      const format = formats.find(format => format.id === id);
      expect(format?.banlist).toBeDefined();
      const list = getBanlist(id);
      console.log(`${id.toUpperCase()} list:`, list ? format?.banlist : "unavailable in upstream checkout");
      if (id !== "edison") expect(list).toBeInstanceOf(Map);
      else if (!list) expect(validateDeck(fixture(), id, db).errors).toContain("Ban list unavailable for Edison: run scripts/fetch-data.sh");
    }
  });

  it("forbids Pot of Greed (55144522) in TCG", () => {
    expect(getBanlist("tcg")?.get(55144522)).toBe(0);
  });

  it.each(["vanilla-dragons", "vanilla-sea"])("validates a TCG-legal variant of %s under the real ban list", name => {
    const deck = fixture(name);
    expect(validateDeck(deck, "tcg", db).errors).toEqual(["Monster Reborn exceeds limit 1 (2 in deck)"]);
    // The shipped fixtures predate format validation and contain two Reborns.
    // Replace one with an unrestricted main-deck monster without editing decks.
    deck.main[deck.main.indexOf(83764718)] = 89631139;
    expect(validateDeck(deck, "tcg", db)).toEqual({ ok: true, errors: [], format: "tcg" });
  });
});
