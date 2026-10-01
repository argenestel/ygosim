import type { Deck } from "@ygosim/protocol";

export interface DeckSpec {
  sample?: string;   // name of a server sample deck (GET /api/decks)
  ydk?: string;      // raw .ydk file text
  main?: number[]; extra?: number[]; side?: number[];
}

export function parseYdk(text: string): Deck {
  const deck: Deck = { main: [], extra: [], side: [] };
  let cur: keyof Deck = "main";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#main")) cur = "main";
    else if (line.startsWith("#extra")) cur = "extra";
    else if (line.startsWith("!side")) cur = "side";
    else if (/^\d+$/.test(line)) deck[cur].push(Number(line));
  }
  return deck;
}

type SampleEntry = { name: string; deck?: Deck; ydk?: string } & Partial<Deck>;

export async function fetchSampleDecks(httpBase: string): Promise<SampleEntry[]> {
  const r = await fetch(`${httpBase}/api/decks`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`GET /api/decks failed: HTTP ${r.status}`);
  const j = (await r.json()) as SampleEntry[] | { decks: SampleEntry[] };
  return Array.isArray(j) ? j : j.decks ?? [];
}

export async function resolveDeck(spec: DeckSpec | undefined, httpBase: string): Promise<Deck> {
  const sources = [spec?.sample !== undefined, spec?.ydk !== undefined, spec?.main !== undefined].filter(Boolean).length;
  if (sources > 1) throw new Error("provide only one deck source: deck sample name, ydk, or main passcodes");
  if (spec?.main === undefined && (spec?.extra !== undefined || spec?.side !== undefined)) throw new Error("extra/side passcodes require main passcodes");
  if (spec?.ydk !== undefined) {
    const deck = parseYdk(spec.ydk);
    if (!deck.main.length) throw new Error("ydk must contain main deck passcodes");
    return deck;
  }
  if (spec?.main) return { main: spec.main, extra: spec.extra ?? [], side: spec.side ?? [] };
  const decks = await fetchSampleDecks(httpBase);
  if (!decks.length) throw new Error("server has no sample decks; pass ydk or main/extra lists");
  const want = spec?.sample?.toLowerCase();
  const e = want ? decks.find((d) => d.name.toLowerCase() === want) ?? decks.find((d) => d.name.toLowerCase().includes(want)) : decks[0];
  if (!e) throw new Error(`no sample deck "${spec?.sample}". Available: ${decks.map((d) => d.name).join(", ")}`);
  if (e.deck) return e.deck;
  if (e.ydk) return parseYdk(e.ydk);
  return { main: e.main ?? [], extra: e.extra ?? [], side: e.side ?? [] };
}
