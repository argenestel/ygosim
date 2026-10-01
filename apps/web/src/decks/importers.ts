import type { Deck } from "@ygosim/protocol";

export type ImportKind = "ydk" | "ydke" | "list" | "unknown";

export interface ParsedImport {
  kind: ImportKind;
  deck: Deck;
  /** Card-name lines that still need resolving to passcodes ("list" imports). */
  names?: { section: keyof Deck; name: string; count: number }[];
  name?: string;
}

const empty = (): Deck => ({ main: [], extra: [], side: [] });

export function detectKind(text: string): ImportKind {
  const t = text.trim();
  if (/^ydke:\/\//i.test(t)) return "ydke";
  if (/^#(main|created)|^!side|^#extra/m.test(t) && /^\d{4,9}$/m.test(t)) return "ydk";
  if (t.split(/\r?\n/).some((l) => /[a-z]/i.test(l))) return "list";
  return "unknown";
}

export function parseYdk(text: string): Deck {
  const d = empty();
  let cur: keyof Deck = "main";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#main")) cur = "main";
    else if (line.startsWith("#extra")) cur = "extra";
    else if (line.startsWith("!side")) cur = "side";
    else if (/^\d+$/.test(line)) d[cur].push(Number(line));
  }
  return d;
}

export const toYdk = (d: Deck) => ["#created by ygosim", "#main", ...d.main, "#extra", ...d.extra, "!side", ...d.side, ""].join("\n");

/** ydke://<main>!<extra>!<side>! where each part is base64 of little-endian uint32 passcodes. */
export function parseYdke(url: string): Deck {
  const parts = url.trim().replace(/^ydke:\/\//i, "").split("!");
  const dec = (b64 = ""): number[] => {
    if (!b64) return [];
    const bin = atob(b64);
    const out: number[] = [];
    for (let i = 0; i + 3 < bin.length; i += 4) {
      out.push((bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8) | (bin.charCodeAt(i + 2) << 16) | (bin.charCodeAt(i + 3) << 24)) >>> 0);
    }
    return out;
  };
  return { main: dec(parts[0]), extra: dec(parts[1]), side: dec(parts[2]) };
}

export function toYdke(d: Deck): string {
  const enc = (codes: number[]) => {
    let bin = "";
    for (const c of codes) bin += String.fromCharCode(c & 255, (c >>> 8) & 255, (c >>> 16) & 255, (c >>> 24) & 255);
    return btoa(bin);
  };
  return `ydke://${enc(d.main)}!${enc(d.extra)}!${enc(d.side)}!`;
}

/**
 * Plain-text card lists as shared on forums / exported by deck sites:
 *   "3 Ash Blossom & Joyous Spring", "Ash Blossom x3", "3x Ash Blossom", headers like "Extra Deck:" / "Side".
 */
export function parseList(text: string): ParsedImport["names"] {
  const out: NonNullable<ParsedImport["names"]> = [];
  let section: keyof Deck = "main";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*•]\s*/, "");
    if (!line) continue;
    const header = line.toLowerCase().replace(/[:#=\-\s]+/g, " ").trim();
    if (/^(main( deck)?|monsters?|spells?|traps?)( \d+)?$/.test(header)) { section = "main"; continue; }
    if (/^extra( deck)?( \d+)?$/.test(header)) { section = "extra"; continue; }
    if (/^side( deck)?( \d+)?$/.test(header)) { section = "side"; continue; }
    let m = line.match(/^(\d)\s*x?\s+(.+)$/i);
    let count = 1, name = line;
    if (m) { count = Number(m[1]); name = m[2]; }
    else if ((m = line.match(/^(.+?)\s*[x×]\s*(\d)$/i))) { name = m[1]; count = Number(m[2]); }
    name = name.replace(/\s*\(.*?\)\s*$/, "").trim();
    if (name) out.push({ section, name, count });
  }
  return out;
}

export function parseImport(text: string): ParsedImport {
  const kind = detectKind(text);
  if (kind === "ydke") return { kind, deck: parseYdke(text) };
  if (kind === "ydk") return { kind, deck: parseYdk(text) };
  if (kind === "list") return { kind, deck: empty(), names: parseList(text) };
  return { kind, deck: empty() };
}
