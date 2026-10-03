import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SqlCardDb, type RawCard, loadCardDb } from "../src/carddb.js";
import { cdbFiles, dataDir, formatCoreText, loadStrings, makeScriptReader } from "../src/data.js";
import { validateDeck } from "../src/formats.js";
import { parseYdk } from "../src/ydk.js";

const originalData = process.env.YGOSIM_DATA;
afterEach(() => {
  if (originalData === undefined) delete process.env.YGOSIM_DATA;
  else process.env.YGOSIM_DATA = originalData;
});

describe("data and deck loading", () => {
  it("finds ordered card databases and reads core scripts", () => {
    const root = dataDir();
    const files = cdbFiles(root);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => file.startsWith(join(root, "BabelCDB")))).toBe(true);

    const readScript = makeScriptReader(root);
    expect(readScript("constant.lua")).toContain("TYPE_MONSTER");
    expect(readScript("c5318639.lua")).toBeTypeOf("string");
    expect(readScript("../strings.conf")).toBeNull();
    expect(readScript("/tmp/c89631139.lua")).toBeNull();
  });

  it("keeps string caches isolated by data root", () => {
    const a = mkdtempSync(join(tmpdir(), "ygosim-data-a-"));
    const b = mkdtempSync(join(tmpdir(), "ygosim-data-b-"));
    writeFileSync(join(a, "strings.conf"), "!system 1 alpha\n");
    writeFileSync(join(b, "strings.conf"), "!system 1 beta\n");
    expect(loadStrings(a).system.get(1)).toBe("alpha");
    expect(loadStrings(b).system.get(1)).toBe("beta");
  });

  it("retries a failed card database load", async () => {
    const valid = dataDir();
    const missing = join(mkdtempSync(join(tmpdir(), "ygosim-missing-")), "data");
    process.env.YGOSIM_DATA = missing;
    await expect(loadCardDb()).rejects.toThrow(/CardScripts|data directory|card database/);
    process.env.YGOSIM_DATA = valid;
    const db = await loadCardDb();
    expect(db.get(89631139)?.name).toBe("Blue-Eyes White Dragon");
  });

  it("decodes current and legacy effect description ids", () => {
    const db = new SqlCardDb();
    const raw: RawCard = {
      code: 123, alias: 0, setcode: 0n, type: 1, atk: 0, def: 0, level: 1, race: 1,
      attribute: 1, ot: 1, name: "test", desc: "", strs: ["first", "second"],
    };
    db.raw.set(raw.code, raw);
    expect(db.effectString((123n << 20n) | 1n)).toBe("second");
    expect(db.effectString((123n << 4n) | 0n)).toBe("first");
  });

  it("formats core card names and numeric placeholders", () => {
    expect(formatCoreText('Use the effect of "%ls"?', "S:P Little Knight")).toBe('Use the effect of "S:P Little Knight"?');
    expect(formatCoreText('Remove %d "%ls"', [2, "Counters"])).toBe('Remove 2 "Counters"');
    expect(formatCoreText("Version mismatch(%X.0%X.%X).", [1, 2, 15])).toBe("Version mismatch(1.02.F).");
    expect(formatCoreText("10%% resolved")).toBe("10% resolved");
  });

  it("does not leak printf placeholders when values are unavailable", () => {
    const text = formatCoreText('Use the effect of "%ls"? Remove %d %s %X %q', []);
    expect(text).toBe('Use the effect of "?"? Remove ? ? ? ?');
    expect(text).not.toMatch(/%[A-Za-z]/);
  });

  it("parses strict deck sections and rejects malformed lines", () => {
    const deck = parseYdk("\uFEFF#created by test\n#main\n89631139\n#extra\n!side\n");
    expect(deck).toEqual({ main: [89631139], extra: [], side: [] });
    expect(() => parseYdk("#main\n0\n")).toThrow(/passcode/);
    expect(() => parseYdk("#main\n123abc\n")).toThrow(/passcode/);
    expect(() => parseYdk("#extra\n89631139\n")).toThrow(/before #main/);
    expect(() => parseYdk("#main\n89631139\n#wat\n")).toThrow(/unknown directive/);
  });

  it.each([
    ["blue-eyes-fusion", "Fusion", 23995346],
    ["junk-synchro", "Synchro", 44508094],
    ["utopia-xyz", "Xyz", 84013237],
    ["link-code-talker", "Link", 1861629],
  ] as const)("loads %s as a 40-card sample with a %s showcase", async (name, type, boss) => {
    const db = await loadCardDb();
    const deck = parseYdk(readFileSync(new URL(`../decks/${name}.ydk`, import.meta.url), "utf8"));
    expect(deck.main).toHaveLength(40);
    expect(deck.extra.length).toBeGreaterThan(0);
    expect(deck.extra.length).toBeLessThanOrEqual(15);
    expect(deck.side).toEqual([]);
    expect(deck.extra).toContain(boss);
    expect(deck.extra.every(code => db.get(code)?.type.includes(type))).toBe(true);
    expect(validateDeck(deck, "unlimited", db)).toEqual({ ok: true, errors: [], format: "unlimited" });
    // The loader also includes prerelease cards: sample decks must be TCG releases.
    for (const code of [...deck.main, ...deck.extra]) expect(db.raw.get(code)!.ot & 2, `${code} is not TCG released`).not.toBe(0);
  });
});
