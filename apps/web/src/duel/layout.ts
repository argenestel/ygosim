import type { CardRef, PlayerIdx } from "@ygosim/protocol";

// Board-plane coordinates (px). Origin = field center. The viewer is always at the bottom.
export const CARD_W = 86;
export const CARD_H = 125;
export const COL = 108;
export const BOARD_W = 1120;
export const BOARD_H = 1000;

const ROW = { emz: 0, mzone: 92, szone: 235, hand: 400 };
const SIDE = 3.05 * COL;

export interface Pos { x: number; y: number; z: number; rot: number; }

export type PileKey = "deck" | "extra" | "grave" | "banished";

/** Anchor of a zone slot for the viewer-relative side (mine = bottom). */
export function slot(loc: CardRef["location"], seq: number, mine: boolean): { x: number; y: number } {
  let x = 0, y = 0;
  switch (loc) {
    case "mzone":
      if (seq >= 5) { x = (seq === 5 ? -1 : 1) * COL; y = -ROW.emz; break; } // EMZ stored as mzone 5/6
      x = (seq - 2) * COL; y = ROW.mzone; break;
    case "emzone": x = (seq === 0 ? -1 : 1) * COL; y = -ROW.emz; break;
    case "szone":
      if (seq === 5) { x = -SIDE; y = ROW.mzone; break; } // field spell stored as szone 5
      x = (Math.min(seq, 4) - 2) * COL; y = ROW.szone; break;
    case "pzone": x = (seq === 0 ? -2 : 2) * COL; y = ROW.szone; break;
    case "fzone": x = -SIDE; y = ROW.mzone; break;
    case "grave": x = SIDE; y = ROW.mzone; break;
    case "banished": x = SIDE + COL * 1.05; y = ROW.mzone; break;
    case "deck": x = SIDE; y = ROW.szone; break;
    case "extra": x = -SIDE; y = ROW.szone; break;
    case "hand": x = 0; y = ROW.hand; break;
  }
  // EMZ is shared: never mirror its y, only the x for the opponent.
  if (!mine) { x = -x; y = loc === "emzone" || (loc === "mzone" && seq >= 5) ? y : -y; }
  return { x, y };
}

export const isPile = (l: CardRef["location"]): l is PileKey =>
  l === "deck" || l === "extra" || l === "grave" || l === "banished";

/** Compute positions for every card given the full list (needs hand/pile ordering). */
export function layoutCards(cards: CardRef[], you: PlayerIdx): Map<string, Pos> {
  const out = new Map<string, Pos>();
  const groups = new Map<string, CardRef[]>();
  for (const c of cards) {
    const k = `${c.controller}:${c.location}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
  }
  for (const [k, list] of groups) {
    const [ctrl, loc] = k.split(":") as [string, CardRef["location"]];
    const mine = Number(ctrl) === you;
    if (loc === "hand") {
      const sorted = [...list].sort((a, b) => a.sequence - b.sequence);
      const n = sorted.length;
      const spread = Math.min(COL * 0.92, 640 / Math.max(n, 1));
      sorted.forEach((c, i) => {
        const off = i - (n - 1) / 2;
        const base = slot("hand", 0, mine);
        out.set(c.uid, {
          x: base.x + off * spread * (mine ? 1 : -1),
          y: base.y + Math.abs(off) * 4 * (mine ? 1 : -1),
          z: mine ? 40 + i : i,
          rot: off * 2.2 * (mine ? 1 : -1),
        });
      });
    } else if (isPile(loc)) {
      const sorted = [...list].sort((a, b) => a.sequence - b.sequence);
      sorted.forEach((c, i) => {
        const base = slot(loc, 0, mine);
        const lift = Math.min(i, 30) * 0.6;
        out.set(c.uid, { x: base.x, y: base.y - lift, z: i, rot: 0 });
      });
    } else {
      for (const c of list) {
        const base = slot(loc, c.sequence, mine);
        out.set(c.uid, { ...base, z: 10, rot: mine ? 0 : 180 });
      }
    }
  }
  return out;
}

/** All empty zone frames to draw on the mat. */
export function zoneFrames(): { key: string; x: number; y: number; label: string; kind: string }[] {
  const frames: { key: string; x: number; y: number; label: string; kind: string }[] = [];
  for (const mine of [true, false]) {
    const p = mine ? "me" : "op";
    for (let i = 0; i < 5; i++) {
      frames.push({ key: `${p}m${i}`, ...slot("mzone", i, mine), label: "", kind: "monster" });
      frames.push({ key: `${p}s${i}`, ...slot("szone", i, mine), label: i === 0 || i === 4 ? "P" : "", kind: "spell" });
    }
    frames.push({ key: `${p}f`, ...slot("fzone", 0, mine), label: "FIELD", kind: "field" });
    frames.push({ key: `${p}g`, ...slot("grave", 0, mine), label: "GY", kind: "pile" });
    frames.push({ key: `${p}b`, ...slot("banished", 0, mine), label: "BANISH", kind: "pile" });
    frames.push({ key: `${p}d`, ...slot("deck", 0, mine), label: "DECK", kind: "pile" });
    frames.push({ key: `${p}e`, ...slot("extra", 0, mine), label: "EXTRA", kind: "pile" });
  }
  frames.push({ key: "emz0", ...slot("emzone", 0, true), label: "EX", kind: "emz" });
  frames.push({ key: "emz1", ...slot("emzone", 1, true), label: "EX", kind: "emz" });
  return frames;
}
