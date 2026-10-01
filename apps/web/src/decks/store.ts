import type { Deck } from "@ygosim/protocol";
import { MOCK_DECK } from "../mockCards";

/** A saved deck, Master Duel-style: named, with a cover card shown on its tile. */
export interface DeckProfile {
  id: string;
  name: string;
  cover?: number;
  deck: Deck;
  updated: number;
}

const KEY = "ygosim.profiles";
const ACTIVE = "ygosim.activeProfile";
const LEGACY = "ygosim.decks";

const uid = () => Math.random().toString(36).slice(2, 10);
const read = <T,>(k: string, fallback: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

const listeners = new Set<() => void>();
export const onDecksChanged = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const emit = () => listeners.forEach((f) => f());

export function listProfiles(): DeckProfile[] {
  let all = read<DeckProfile[]>(KEY, []);
  if (!all.length) {
    // Migrate decks saved by the previous deck builder.
    const legacy = read<Record<string, Deck>>(LEGACY, {});
    all = Object.entries(legacy).map(([name, deck]) => ({ id: uid(), name, deck, updated: Date.now() }));
    if (!all.length) all = [{ id: uid(), name: "Starter Deck", deck: MOCK_DECK, cover: 89631139, updated: Date.now() }];
    write(KEY, all);
  }
  return all.sort((a, b) => b.updated - a.updated);
}

export function getProfile(id: string) { return listProfiles().find((p) => p.id === id); }

export function saveProfile(p: DeckProfile) {
  const all = listProfiles().filter((x) => x.id !== p.id);
  write(KEY, [{ ...p, updated: Date.now() }, ...all]);
  emit();
}

export function createProfile(name: string, deck: Deck = { main: [], extra: [], side: [] }, cover?: number): DeckProfile {
  const p: DeckProfile = { id: uid(), name: uniqueName(name), deck, cover: cover ?? deck.main[0] ?? deck.extra[0], updated: Date.now() };
  saveProfile(p);
  return p;
}

export function deleteProfile(id: string) {
  write(KEY, listProfiles().filter((p) => p.id !== id));
  if (activeProfileId() === id) setActiveProfile(listProfiles()[0]?.id ?? "");
  emit();
}

export function duplicateProfile(id: string) {
  const p = getProfile(id);
  return p ? createProfile(`${p.name} (copy)`, structuredClone(p.deck), p.cover) : undefined;
}

function uniqueName(name: string) {
  const names = new Set(read<DeckProfile[]>(KEY, []).map((p) => p.name));
  if (!names.has(name)) return name;
  for (let i = 2; ; i++) if (!names.has(`${name} ${i}`)) return `${name} ${i}`;
}

export function activeProfileId(): string {
  const id = read<string>(ACTIVE, "");
  const all = listProfiles();
  return all.some((p) => p.id === id) ? id : all[0]?.id ?? "";
}
export function setActiveProfile(id: string) { write(ACTIVE, id); emit(); }
export function activeProfile(): DeckProfile | undefined { return getProfile(activeProfileId()); }

export const coverOf = (p: DeckProfile) => p.cover ?? p.deck.main[0] ?? p.deck.extra[0];

const SEEDED = "ygosim.seeded";
/**
 * First run: replace the placeholder starter with the server's legal sample decks,
 * so a new player can start a real duel immediately.
 */
export async function seedSampleDecks(fetchDecks: () => Promise<{ name: string; deck: Deck }[]>) {
  if (read<boolean>(SEEDED, false)) return;
  const samples = await fetchDecks().catch(() => []);
  if (!samples.length) return;
  const all = read<DeckProfile[]>(KEY, []);
  const kept = all.filter((p) => !(p.name === "Starter Deck" && p.deck.main.length < 40));
  const titled = (n: string) => n.replace(/\b\w/g, (c) => c.toUpperCase());
  const added = samples.map((d) => ({ id: uid(), name: titled(d.name), deck: d.deck, cover: d.deck.extra[0] ?? d.deck.main[0], updated: Date.now() - 1000 }));
  write(KEY, [...kept, ...added]);
  write(SEEDED, true);
  if (!kept.some((p) => p.id === read<string>(ACTIVE, ""))) write(ACTIVE, added[0].id);
  emit();
}
