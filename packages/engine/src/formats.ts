import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CardDb, Deck, DeckValidation, Format, FormatId } from "@ygosim/protocol";
import type { RawCard } from "./carddb.js";
import { dataDir } from "./data.js";

type Limit = 0 | 1 | 2;
interface Banlist {
  name: string;
  date: number;
  limits: Map<number, Limit>;
  listed: Set<number>;
  whitelist: boolean;
}

const definitions: Format[] = [
  { id: "tcg", name: "TCG", description: "Current TCG standard", banlist: "Latest TCG" },
  { id: "ocg", name: "OCG", description: "Current OCG standard", banlist: "Latest OCG" },
  { id: "traditional", name: "Traditional", description: "TCG forbidden cards are limited", banlist: "Latest TCG", traditional: true },
  { id: "unlimited", name: "Unlimited", description: "No ban list", banlist: "" },
  { id: "goat", name: "GOAT", description: "GOAT whitelist", banlist: "GOAT Whitelist", masterRule: 1, whitelist: true },
  { id: "edison", name: "Edison", description: "Edison whitelist", banlist: "Edison Whitelist", masterRule: 1, whitelist: true },
  { id: "speed", name: "Speed Duel", description: "Speed Duel rules", banlist: "Speed Duel", startingLp: 4000, startingHand: 4,
    deck: { mainMin: 20, mainMax: 30, extraMax: 5, sideMax: 6 } },
].map(definition => ({ masterRule: 5, startingLp: 8000, startingHand: 5, drawPerTurn: 1,
  deck: { mainMin: 40, mainMax: 60, extraMax: 15, sideMax: 15 }, ...definition }));

const cache = new Map<string, Map<string, Banlist>>();

function dateOf(text: string): number {
  const match = /(?:^|\D)(\d{4})[-.](\d{1,2})(?:[-.](\d{1,2}))?(?:\D|$)/.exec(text);
  if (!match) return 0;
  const month = Number(match[2]), day = Number(match[3] ?? 1);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
    ? Number(match[1]) * 10000 + month * 100 + day : 0;
}

function category(name: string): string | undefined {
  // Prefer historical/special categories over incidental mentions of TCG/OCG.
  if (/traditional|rush|world/i.test(name)) return undefined;
  if (/\bgoat\b/i.test(name)) return "goat";
  if (/\bedison\b/i.test(name)) return "edison";
  if (/\bspeed\b/i.test(name)) return "speed";
  if (/\btcg\b/i.test(name)) return "tcg";
  if (/\bocg\b/i.test(name)) return "ocg";
  return undefined;
}

function loadBanlists(): Map<string, Banlist> {
  let root: string;
  try { root = join(dataDir(), "LFLists"); } catch { return new Map(); }
  const cached = cache.get(root);
  if (cached) return cached;
  const lists = new Map<string, Banlist>();
  cache.set(root, lists);
  if (!existsSync(root)) return lists;
  function readDirectory(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { readDirectory(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".lflist.conf")) continue;
      const parsed: Banlist[] = [];
      let current: Banlist | undefined;
      let malformed = false;
      for (const raw of readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
        const line = raw.split(/#|--/)[0].trim();
        if (!line) continue;
        if (line.startsWith("!")) {
          current = { name: line.slice(1).trim(), date: dateOf(entry.name) || dateOf(line),
            limits: new Map(), listed: new Set(), whitelist: false };
          parsed.push(current);
        } else if (line === "$whitelist" && current) current.whitelist = true;
        else if (current) {
          const match = /^(\d+)\s+([0-3])$/.exec(line);
          if (!match || Number(match[1]) <= 0 || !Number.isSafeInteger(Number(match[1]))) { malformed = true; break; }
          const code = Number(match[1]), limit = Number(match[2]);
          current.listed.add(code);
          if (limit < 3) current.limits.set(code, limit as Limit);
          else current.limits.delete(code);
        } else { malformed = true; break; }
      }
      if (malformed) continue;
      for (const list of parsed) {
        const id = category(list.name) ?? category(entry.name.replace(/[._-]/g, " "));
        if (!id || !list.name || list.listed.size === 0) continue;
        if (!lists.has(id) || list.date > lists.get(id)!.date) lists.set(id, list);
      }
    }
  }
  try { readDirectory(root); } catch { lists.clear(); }
  return lists;
}

/** Registry snapshots include the selected LFLists header when available. */
export function listFormats(): Format[] {
  const lists = loadBanlists();
  return definitions.map(format => ({ ...format, deck: { ...format.deck },
    banlist: lists.get(format.traditional ? "tcg" : format.id)?.name ?? format.banlist }));
}

/**
 * Restrictions only; whitelist entries with limit 3 are tracked internally.
 * Missing/unreadable LFLists or malformed lists return null. Restricted deck
 * validation then fails with an actionable error; Edison requires a supplied
 * Edison whitelist when the checkout does not include one.
 */
export function getBanlist(format: FormatId): Map<number, Limit> | null {
  if (!definitions.some(definition => definition.id === format) || format === "unlimited") return null;
  const list = loadBanlists().get(format === "traditional" ? "tcg" : format);
  return list ? new Map(list.limits) : null;
}

export function validateDeck(deck: Deck, format: FormatId, db: CardDb): DeckValidation {
  const errors: string[] = [];
  const rules = definitions.find(definition => definition.id === format);
  if (!rules) return { ok: false, errors: [`Invalid format: ${format}`], format };
  const { mainMin, mainMax, extraMax, sideMax } = rules.deck;
  if (deck.main.length < mainMin || deck.main.length > mainMax) errors.push(`Main deck must contain ${mainMin}–${mainMax} cards (${deck.main.length} in deck)`);
  if (deck.extra.length > extraMax) errors.push(`Extra deck exceeds ${extraMax} cards (${deck.extra.length} in deck)`);
  if (deck.side.length > sideMax) errors.push(`Side deck exceeds ${sideMax} cards (${deck.side.length} in deck)`);
  const list = rules.banlist ? loadBanlists().get(rules.traditional ? "tcg" : format) : undefined;
  if (rules.banlist && !list) errors.push(`Ban list unavailable for ${rules.name}: run scripts/fetch-data.sh`);
  if (rules.whitelist && list && !list.whitelist) errors.push(`Whitelist unavailable for ${rules.name}: missing $whitelist marker`);
  // The existing SQL loader retains aliases and numeric type flags. Generic
  // protocol databases still support validation through their public card types.
  const raw = (db as CardDb & { raw?: Map<number, RawCard> }).raw;
  const identityOf = (code: number) => raw?.get(code)?.alias || code;
  const limits = new Map<number, Limit>();
  const listed = new Set<number>();
  if (list) {
    for (const code of list.listed) listed.add(identityOf(code));
    for (const [code, limit] of list.limits) {
      const identity = identityOf(code);
      limits.set(identity, Math.min(limits.get(identity) ?? 3, limit) as Limit);
    }
  }
  const copies = new Map<number, { count: number; name: string }>();
  for (const [zone, codes] of [["main", deck.main], ["extra", deck.extra], ["side", deck.side]] as const) {
    for (const code of codes) {
      const card = db.get(code);
      if (!card) { errors.push(`Unknown card passcode ${code}`); continue; }
      const numericType = raw?.get(code)?.type;
      const token = numericType === undefined ? card.type.includes("Token") : !!(numericType & 0x4000);
      if (token) errors.push(`Tokens cannot be included in a deck: ${card.name}`);
      const extra = numericType === undefined
        ? card.type.some(type => ["Fusion", "Synchro", "Xyz", "Link"].includes(type))
        : !!(numericType & (0x40 | 0x2000 | 0x800000 | 0x4000000));
      if ((zone === "main" && extra) || (zone === "extra" && !extra)) errors.push(`Invalid ${zone} deck card: ${card.name}`);
      const identity = identityOf(code);
      const entry = copies.get(identity) ?? { count: 0, name: db.get(identity)?.name ?? card.name };
      entry.count++;
      copies.set(identity, entry);
    }
  }
  for (const [identity, { count, name }] of copies) {
    if (list && (rules.whitelist || list.whitelist) && !listed.has(identity)) {
      errors.push(`${name} is not legal in ${rules.name} (not on whitelist)`);
      continue;
    }
    let limit: number = limits.get(identity) ?? 3;
    if (rules.traditional && limit === 0) limit = 1;
    if (limit === 0) errors.push(`${name} is Forbidden in ${rules.name}`);
    else if (count > limit) errors.push(`${name} exceeds limit ${limit} (${count} in deck)`);
  }
  return { ok: errors.length === 0, errors, format };
}
