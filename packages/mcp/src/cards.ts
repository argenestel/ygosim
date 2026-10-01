import type { CardData } from "@ygosim/protocol";

/** Cached HTTP lookups against the game server's card API. */
export class CardCache {
  private cache = new Map<number, CardData | null>();
  constructor(private httpBase: string) {}

  async get(code: number): Promise<CardData | undefined> {
    if (this.cache.has(code)) return this.cache.get(code) ?? undefined;
    const r = await fetch(`${this.httpBase}/api/cards/${code}`, { signal: AbortSignal.timeout(5000) });
    if (r.status === 404) { this.cache.set(code, null); return undefined; }
    if (!r.ok) throw new Error(`card lookup failed: HTTP ${r.status}`);
    const card = (await r.json()) as CardData;
    this.cache.set(code, card);
    return card;
  }

  nameSync(code?: number): string | undefined {
    return code === undefined ? undefined : this.cache.get(code)?.name;
  }

  async prefetch(codes: Iterable<number | undefined>): Promise<void> {
    const todo = [...new Set([...codes].filter((c): c is number => c !== undefined && !this.cache.has(c)))];
    await Promise.all(todo.map((c) => this.get(c).catch(() => undefined)));
  }

  async search(q: string): Promise<CardData[]> {
    const r = await fetch(`${this.httpBase}/api/cards?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`card search failed: HTTP ${r.status}`);
    const j = (await r.json()) as CardData[] | { cards: CardData[] };
    const list = Array.isArray(j) ? j : j.cards ?? [];
    for (const c of list) this.cache.set(c.code, c);
    return list;
  }
}
