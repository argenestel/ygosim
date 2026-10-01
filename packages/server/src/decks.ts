import type { CardDb, Deck } from "@ygosim/protocol";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYdkLocal } from "./engine.js";

const DECK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "decks");

export interface SampleDeck { id: string; name: string; deck: Deck; }

export function sampleDecks(parse: (t: string) => Deck = parseYdkLocal): SampleDeck[] {
  if (!existsSync(DECK_DIR)) return [];
  return readdirSync(DECK_DIR).filter((f) => f.endsWith(".ydk")).map((f) => {
    const id = basename(f, ".ydk");
    return { id, name: id.replace(/[-_]/g, " "), deck: parse(readFileSync(join(DECK_DIR, f), "utf8")) };
  });
}

export interface ValidationResult { ok: boolean; errors: string[]; }

export function validateDeck(deck: unknown, db?: CardDb | null): ValidationResult {
  const errors: string[] = [];
  const d = deck as Deck;
  if (!d || typeof d !== "object") return { ok: false, errors: ["deck must be an object {main, extra, side}"] };
  for (const k of ["main", "extra", "side"] as const) {
    if (!Array.isArray(d[k]) || !d[k].every((c) => Number.isInteger(c) && c > 0))
      errors.push(`${k} must be an array of passcodes`);
  }
  if (errors.length) return { ok: false, errors };
  if (d.main.length < 40 || d.main.length > 60) errors.push(`main deck must have 40-60 cards (has ${d.main.length})`);
  if (d.extra.length > 15) errors.push(`extra deck max 15 (has ${d.extra.length})`);
  if (d.side.length > 15) errors.push(`side deck max 15 (has ${d.side.length})`);
  const counts = new Map<number, number>();
  for (const c of [...d.main, ...d.extra, ...d.side]) counts.set(c, (counts.get(c) ?? 0) + 1);
  for (const [c, n] of counts) if (n > 3) errors.push(`card ${c} appears ${n} times (max 3)`);
  if (db) {
    for (const c of counts.keys()) {
      const cd = db.get(c);
      if (!cd) { errors.push(`unknown card ${c}`); continue; }
      const isExtra = cd.type.some((t) => ["Fusion", "Synchro", "Xyz", "Link"].includes(t));
      if (isExtra && d.main.includes(c)) errors.push(`${cd.name} (${c}) belongs in the extra deck`);
      if (!isExtra && d.extra.includes(c)) errors.push(`${cd.name} (${c}) cannot be in the extra deck`);
    }
  }
  return { ok: errors.length === 0, errors };
}
