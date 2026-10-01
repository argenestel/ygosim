import type { Deck } from "@ygosim/protocol";
import { MOCK_DECK } from "./mockCards";

export function parseYdk(text: string): Deck {
  const d: Deck = { main: [], extra: [], side: [] };
  let cur: keyof Deck = "main";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#main")) cur = "main";
    else if (line.startsWith("#extra")) cur = "extra";
    else if (line.startsWith("!side")) cur = "side";
    else if (/^\d+$/.test(line)) d[cur].push(Number(line));
  }
  return d;
}

export function toYdk(d: Deck): string {
  return ["#created by ygosim", "#main", ...d.main, "#extra", ...d.extra, "!side", ...d.side, ""].join("\n");
}

const KEY = "ygosim.decks";
const ACTIVE = "ygosim.activeDeck";
export type SavedDecks = Record<string, Deck>;

export function loadDecks(): SavedDecks {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (Object.keys(d).length) return d;
  } catch {}
  return { "Starter (demo)": MOCK_DECK };
}
export function saveDecks(d: SavedDecks) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch {} }
export function activeDeckName(): string {
  const all = loadDecks();
  const n = (() => { try { return localStorage.getItem(ACTIVE); } catch { return null; } })();
  return n && all[n] ? n : Object.keys(all)[0];
}
export function setActiveDeck(n: string) { try { localStorage.setItem(ACTIVE, n); } catch {} }
export function activeDeck(): Deck { return loadDecks()[activeDeckName()] ?? MOCK_DECK; }

export function playerName(): string { try { return localStorage.getItem("ygosim.name") || "Duelist"; } catch { return "Duelist"; } }
export function setPlayerName(n: string) { try { localStorage.setItem("ygosim.name", n); } catch {} }
