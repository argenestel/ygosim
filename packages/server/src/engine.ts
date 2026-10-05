import type { CardDb, Deck, Duel, DuelOptions, Format, FormatId } from "@ygosim/protocol";

export interface EngineApi {
  createDuel(opts: DuelOptions): Promise<Duel>;
  loadCardDb(): Promise<CardDb>;
  parseYdk(text: string): Deck;
  listFormats(): Format[] | Promise<Format[]>;
  getBanlist(format: FormatId): Map<number, 0 | 1 | 2> | null | Promise<Map<number, 0 | 1 | 2> | null>;
  validateDeck(deck: Deck, format: FormatId, db: CardDb): { ok: boolean; errors: string[] } | Promise<{ ok: boolean; errors: string[] }>;
}

/** Local fallback .ydk parser (same format as YGOPro). */
export function parseYdkLocal(text: string): Deck {
  const deck: Deck = { main: [], extra: [], side: [] };
  let cur: keyof Deck = "main";
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith("#created")) continue;
    if (l === "#main") cur = "main";
    else if (l === "#extra") cur = "extra";
    else if (l === "!side") cur = "side";
    else if (/^\d+$/.test(l)) deck[cur].push(Number(l));
  }
  return deck;
}

/** Default formats for fallback. */
export const defaultFormats: Format[] = [
  {
    id: "tcg",
    name: "TCG",
    description: "Advanced Format (TCG)",
    banlist: "2024.04 TCG",
    masterRule: 5,
    startingLp: 8000,
    startingHand: 5,
    drawPerTurn: 1,
    deck: { mainMin: 40, mainMax: 60, extraMax: 15, sideMax: 15 },
  },
];

let cached: Promise<EngineApi | null> | undefined;
/** Lazily imports @ygosim/engine; resolves null if it is not available yet. */
export function loadEngine(): Promise<EngineApi | null> {
  cached ??= import("@ygosim/engine").then(
    (m) => m as EngineApi,
    (e) => { console.warn(`[server] engine unavailable: ${(e as Error).message}`); return null; },
  );
  return cached;
}
