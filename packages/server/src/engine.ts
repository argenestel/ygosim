import type { CardDb, Deck, Duel, DuelOptions } from "@ygosim/protocol";

export interface EngineApi {
  createDuel(opts: DuelOptions): Promise<Duel>;
  loadCardDb(): Promise<CardDb>;
  parseYdk(text: string): Deck;
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

let cached: Promise<EngineApi | null> | undefined;
/** Lazily imports @ygosim/engine; resolves null if it is not available yet. */
export function loadEngine(): Promise<EngineApi | null> {
  const spec = "@ygosim/engine";
  cached ??= import(/* @vite-ignore */ spec).then(
    (m) => m as EngineApi,
    (e) => { console.warn(`[server] engine unavailable: ${(e as Error).message}`); return null; },
  );
  return cached;
}
