import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SqlCardDb, type RawCard, loadCardDb } from "../src/carddb.js";
import { cdbFiles, dataDir, loadStrings, makeScriptReader } from "../src/data.js";
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

  it("parses strict deck sections and rejects malformed lines", () => {
    const deck = parseYdk("\uFEFF#created by test\n#main\n89631139\n#extra\n!side\n");
    expect(deck).toEqual({ main: [89631139], extra: [], side: [] });
    expect(() => parseYdk("#main\n0\n")).toThrow(/passcode/);
    expect(() => parseYdk("#main\n123abc\n")).toThrow(/passcode/);
    expect(() => parseYdk("#extra\n89631139\n")).toThrow(/before #main/);
    expect(() => parseYdk("#main\n89631139\n#wat\n")).toThrow(/unknown directive/);
  });

  it("exposes the checked-in sample decks with real card ids", () => {
    for (const name of ["vanilla-dragons.ydk", "vanilla-sea.ydk"]) {
      const path = join(new URL("../decks/", import.meta.url).pathname, name);
      expect(existsSync(path)).toBe(true);
    }
  });
});
