import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { CardData, CardDb } from "@ygosim/protocol";
import type { OcgCardData } from "ocgcore-wasm";
import { cdbFiles, dataDir } from "./data.js";

export interface RawCard {
  code: number; alias: number; setcode: bigint; type: number; atk: number; def: number;
  level: number; race: number; attribute: number; ot: number;
  name: string; desc: string; strs: string[];
}

const TYPE_NAMES: [number, string][] = [
  [0x1, "Monster"], [0x2, "Spell"], [0x4, "Trap"], [0x10, "Normal"], [0x20, "Effect"],
  [0x40, "Fusion"], [0x80, "Ritual"], [0x100, "Trap Monster"], [0x200, "Spirit"], [0x400, "Union"],
  [0x800, "Gemini"], [0x1000, "Tuner"], [0x2000, "Synchro"], [0x4000, "Token"], [0x10000, "Quick-Play"],
  [0x20000, "Continuous"], [0x40000, "Equip"], [0x80000, "Field"], [0x100000, "Counter"],
  [0x200000, "Flip"], [0x400000, "Toon"], [0x800000, "Xyz"], [0x1000000, "Pendulum"],
  [0x2000000, "Special Summon"], [0x4000000, "Link"],
];
export const RACE_NAMES: [number, string][] = [
  "Warrior", "Spellcaster", "Fairy", "Fiend", "Zombie", "Machine", "Aqua", "Pyro", "Rock", "Winged Beast",
  "Plant", "Insect", "Thunder", "Dragon", "Beast", "Beast-Warrior", "Dinosaur", "Fish", "Sea Serpent",
  "Reptile", "Psychic", "Divine-Beast", "Creator God", "Wyrm", "Cyberse", "Illusion",
].map((n, i) => [2 ** i, n]);
export const ATTR_NAMES: [number, string][] = [
  [1, "EARTH"], [2, "WATER"], [4, "FIRE"], [8, "WIND"], [16, "LIGHT"], [32, "DARK"], [64, "DIVINE"],
];
const LINK_NAMES: [number, string][] = [
  [0x1, "Bottom-Left"], [0x2, "Bottom"], [0x4, "Bottom-Right"], [0x8, "Left"],
  [0x20, "Right"], [0x40, "Top-Left"], [0x80, "Top"], [0x100, "Top-Right"],
];
const flags = (v: number, table: [number, string][]) => table.filter(([b]) => (v & b) !== 0).map(([, n]) => n);
const one = (v: number, table: [number, string][]) => table.find(([b]) => b === v)?.[1];

export function toCardData(r: RawCard): CardData {
  const isMonster = (r.type & 1) !== 0;
  const isLink = (r.type & 0x4000000) !== 0;
  const d: CardData = {
    code: r.code, name: r.name, desc: r.desc, type: flags(r.type, TYPE_NAMES),
    imageUrl: `https://images.ygoprodeck.com/images/cards/${r.code}.jpg`,
  };
  if (isMonster) {
    d.attribute = one(r.attribute, ATTR_NAMES);
    d.race = one(r.race, RACE_NAMES);
    d.level = r.level & 0xff;
    // BabelCDB uses -2 for printed “?” values. Keep that sentinel in the
    // raw/core representation, but omit it from the public card data so
    // consumers can distinguish an unknown stat from a numeric value.
    if (r.atk >= 0) d.atk = r.atk;
    else d.atkUnknown = true;
    if (isLink) d.linkMarkers = flags(r.def, LINK_NAMES);
    else if (r.def >= 0) d.def = r.def;
    else d.defUnknown = true;
    if (r.type & 0x1000000) d.scale = (r.level >> 24) & 0xff;
  }
  return d;
}

export function toOcgCard(r: RawCard): OcgCardData {
  const setcodes: number[] = [];
  let sc = r.setcode;
  while (sc > 0n) { const v = Number(sc & 0xffffn); if (v) setcodes.push(v); sc >>= 16n; }
  const isLink = (r.type & 0x4000000) !== 0;
  return {
    code: r.code, alias: r.alias, setcodes, type: r.type, level: r.level & 0xff,
    attribute: r.attribute, race: BigInt(r.race) as any, attack: r.atk, defense: isLink ? 0 : r.def,
    lscale: (r.level >> 24) & 0xff, rscale: (r.level >> 16) & 0xff, link_marker: isLink ? r.def : 0,
  };
}

export class SqlCardDb implements CardDb {
  readonly raw = new Map<number, RawCard>();
  private dataCache = new Map<number, CardData>();

  get(code: number): CardData | undefined {
    let d = this.dataCache.get(code);
    if (!d) {
      const r = this.raw.get(code);
      if (!r) return undefined;
      d = toCardData(r);
      this.dataCache.set(code, d);
    }
    return d;
  }

  search(q: { name?: string; type?: string; limit?: number }): CardData[] {
    const limit = q.limit ?? 50;
    const name = q.name?.toLowerCase();
    const type = q.type?.toLowerCase();
    const out: CardData[] = [];
    const exact: CardData[] = [];
    for (const r of this.raw.values()) {
      if (r.alias && this.raw.has(r.alias) && Math.abs(r.alias - r.code) < 20) continue; // alt arts
      if (name && !r.name.toLowerCase().includes(name)) continue;
      const d = this.get(r.code)!;
      if (type && !d.type.some((t) => t.toLowerCase() === type)) continue;
      if (name && r.name.toLowerCase() === name) exact.push(d); else out.push(d);
      if (exact.length + out.length >= limit * 4 && !name) break;
    }
    return [...exact, ...out].slice(0, limit);
  }

  name(code: number): string { return this.raw.get(code)?.name ?? `#${code}`; }

  /** Effect description string: desc = (code << 20) | string index. */
  effectString(desc: bigint | number): string | undefined {
    const d = BigInt(desc);
    const code = Number(d >> 20n);
    const idx = Number(d & 0xfffffn);
    const modern = this.raw.get(code)?.strs[idx];
    if (modern?.trim()) return modern.trim();

    // Older cores encoded the index in four bits. Keep this fallback for
    // callers replaying old messages while preferring the current encoding.
    const legacyCode = Number(d >> 4n);
    const legacyIdx = Number(d & 0xfn);
    const legacy = this.raw.get(legacyCode)?.strs[legacyIdx];
    return legacy?.trim() ? legacy.trim() : undefined;
  }
}

let shared: Promise<SqlCardDb> | undefined;

/** Loads (once, cached) cards.cdb + release/prerelease cdbs. */
export function loadCardDb(): Promise<SqlCardDb> {
  if (shared) return shared;
  const pending = (async () => {
    const require = createRequire(import.meta.url);
    const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
    const db = new SqlCardDb();
    const files = cdbFiles(dataDir());
    if (!files.length) throw new Error("ygosim card databases not found: run scripts/fetch-data.sh");
    for (const file of files) {
      const sdb = new SQL.Database(readFileSync(file));
      try {
        const res = sdb.exec(
          "SELECT d.id,d.ot,d.alias,CAST(d.setcode AS TEXT),d.type,d.atk,d.def,d.level,d.race,d.attribute,t.name,t.desc," +
          Array.from({ length: 16 }, (_, i) => `t.str${i + 1}`).join(",") +
          " FROM datas d JOIN texts t ON d.id=t.id",
        );
        for (const row of res[0]?.values ?? []) {
          const [id, ot, alias, setcode, type, atk, def, level, race, attribute, name, desc, ...strs] = row as any[];
          db.raw.set(Number(id), {
            code: Number(id), ot: Number(ot), alias: Number(alias), setcode: BigInt(setcode ?? 0) & 0xffffffffffffffffn,
            type: Number(type), atk: Number(atk), def: Number(def), level: Number(level), race: Number(race),
            attribute: Number(attribute), name: String(name ?? ""), desc: String(desc ?? ""),
            strs: strs.map((s) => String(s ?? "")),
          });
        }
      } finally { sdb.close(); }
    }
    return db;
  })();
  let retryable: Promise<SqlCardDb>;
  retryable = pending.catch((error: unknown) => {
    // A missing or incomplete checkout should not poison the process forever;
    // a later call can succeed after the data has been fetched or repaired.
    if (shared === retryable) shared = undefined;
    throw error;
  });
  shared = retryable;
  return retryable;
}
