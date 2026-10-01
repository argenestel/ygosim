import type { CardData, Deck, DeckValidation, Format, FormatId } from "@ygosim/protocol";
import { MOCK_CARDS } from "./mockCards";

export const isMock = new URLSearchParams(location.search).get("mock") === "1";

export function wsUrl(): string {
  const env = (import.meta as any).env?.VITE_WS_URL as string | undefined;
  if (env) return env;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // In dev, Vite proxies /ws to :7777. In a static deploy, assume same host.
  return `${proto}//${location.host}/ws`;
}

export function imageFor(code: number) {
  return `https://images.ygoprodeck.com/images/cards/${code}.jpg`;
}

const cache = new Map<number, CardData>();
const inflight = new Map<number, Promise<CardData>>();
const listeners = new Set<() => void>();
export function onCardCache(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function peekCard(code?: number) { return code ? cache.get(code) : undefined; }

function fallback(code: number): CardData {
  return MOCK_CARDS[code] ?? { code, name: `Card #${code}`, desc: "", type: ["Monster"], imageUrl: imageFor(code) };
}

export function getCard(code: number): Promise<CardData> {
  const hit = cache.get(code);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(code);
  if (!p) {
    p = (isMock ? Promise.reject(new Error("mock")) : fetch(`/api/cards/${code}`).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    }))
      .then((j: any) => (j && j.card ? j.card : j) as CardData)
      .catch(() => fallback(code))
      .then((c) => { cache.set(code, c); listeners.forEach((l) => l()); return c; });
    inflight.set(code, p);
  }
  return p;
}

function arr<T>(j: any, key: string): T[] {
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j[key])) return j[key];
  if (j && Array.isArray(j.results)) return j.results;
  return [];
}

export async function searchCards(q: string): Promise<CardData[]> {
  try {
    const r = await fetch(`/api/cards?q=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error();
    const list = arr<CardData>(await r.json(), "cards");
    list.forEach((c) => cache.set(c.code, c));
    return list;
  } catch {
    const ql = q.toLowerCase();
    return Object.values(MOCK_CARDS).filter((c) => c.name.toLowerCase().includes(ql));
  }
}

export interface RoomInfo { roomId: string; players: string[]; status: string; format?: string; match?: string; }
export async function listRooms(): Promise<RoomInfo[]> {
  try {
    const r = await fetch(`/api/rooms`);
    if (!r.ok) return [];
    return arr<any>(await r.json(), "rooms").map((x) => ({
      roomId: x.roomId ?? x.id, status: x.status ?? "?", format: x.format, match: x.match,
      players: (x.players ?? []).map((p: any) => (typeof p === "string" ? p : p?.name ?? "?")),
    }));
  } catch { return []; }
}

export interface PresetDeck { name: string; deck: Deck; }
export async function listPresetDecks(): Promise<PresetDeck[]> {
  try {
    const r = await fetch(`/api/decks`);
    if (!r.ok) return [];
    return arr<any>(await r.json(), "decks")
      .map((x) => ({ name: x.name ?? x.id ?? "Deck", deck: x.deck ?? x }))
      .filter((x) => Array.isArray(x.deck?.main));
  } catch { return []; }
}

export async function validateDeck(deck: Deck, format: FormatId = "tcg"): Promise<DeckValidation> {
  try {
    const r = await fetch(`/api/decks/validate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deck, format }),
    });
    const j: any = await r.json().catch(() => ({}));
    const errors: string[] = j.errors ?? (j.error ? [j.error] : []);
    return { ok: j.ok ?? j.valid ?? (r.ok && errors.length === 0), errors, format };
  } catch {
    return { ok: false, errors: ["Validation server unreachable"], format };
  }
}

/** Offline fallback so the UI still works in demo mode. */
const DEFAULT_FORMATS: Format[] = [
  { id: "tcg", name: "Advanced (TCG)", description: "Current TCG Forbidden & Limited list, Master Rule 5.", banlist: "TCG", masterRule: 5, startingLp: 8000, startingHand: 5, drawPerTurn: 1, deck: { mainMin: 40, mainMax: 60, extraMax: 15, sideMax: 15 } },
  { id: "ocg", name: "Advanced (OCG)", description: "Current OCG list, Master Rule 5.", banlist: "OCG", masterRule: 5, startingLp: 8000, startingHand: 5, drawPerTurn: 1, deck: { mainMin: 40, mainMax: 60, extraMax: 15, sideMax: 15 } },
  { id: "unlimited", name: "Unlimited", description: "Every card, no list.", banlist: "", masterRule: 5, startingLp: 8000, startingHand: 5, drawPerTurn: 1, deck: { mainMin: 40, mainMax: 60, extraMax: 15, sideMax: 15 } },
];
let formatsP: Promise<Format[]> | undefined;
export function listFormats(): Promise<Format[]> {
  return (formatsP ??= (isMock ? Promise.reject() : fetch(`/api/formats`).then((r) => (r.ok ? r.json() : Promise.reject())))
    .then((j: any) => { const l = arr<Format>(j, "formats"); return l.length ? l : DEFAULT_FORMATS; })
    .catch(() => DEFAULT_FORMATS));
}

const banCache = new Map<string, Promise<Record<number, 0 | 1 | 2>>>();
export function getBanlist(format: FormatId): Promise<Record<number, 0 | 1 | 2>> {
  let p = banCache.get(format);
  if (!p) {
    p = (isMock ? Promise.resolve({}) : fetch(`/api/banlist/${encodeURIComponent(format)}`).then((r) => (r.ok ? r.json() : {})))
      .then((j: any) => (j && typeof j === "object" ? (j.cards ?? j.list ?? j) : {}))
      .catch(() => ({}));
    banCache.set(format, p);
  }
  return p;
}
