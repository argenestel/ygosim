import type { CardRef, PlayerIdx } from "@ygosim/protocol";
import { CARD_H, CARD_W, isPile, layoutCards, slot } from "../duel/layout";

/** 100 layout px = 1 world unit. Table lies in the XZ plane, +Z toward the viewer. */
export const S = 1 / 100;
export const CW = CARD_W * S;
export const CH = CARD_H * S;
export const HAND_TILT = 1.05; // radians the viewer's hand is stood up toward the camera

export interface Target { x: number; y: number; z: number; yaw: number; roll: number; }

export function worldTargets(cards: CardRef[], you: PlayerIdx): Map<string, Target> {
  const flat = layoutCards(cards, you);
  const out = new Map<string, Target>();
  for (const c of cards) {
    const p = flat.get(c.uid);
    if (!p) continue;
    const mine = c.controller === you;
    if (c.location === "hand") {
      // Viewer's hand floats in front of the camera; opponent's hand sits beyond their field.
      out.set(c.uid, mine
        ? { x: p.x * S * 1.05, y: 1.35 + (p.z - 40) * 0.004, z: 4.35 + Math.abs(p.x * S) * 0.04, yaw: 0, roll: -p.rot * (Math.PI / 180) }
        : { x: p.x * S * 0.8, y: 0.3 + p.z * 0.004, z: -4.3, yaw: Math.PI, roll: 0 });
      continue;
    }
    const pile = isPile(c.location);
    out.set(c.uid, {
      x: p.x * S, z: p.y * S,
      y: pile ? 0.012 + p.z * 0.014 : 0.02,
      yaw: mine ? 0 : Math.PI, roll: 0,
    });
  }
  return out;
}

export function slotWorld(loc: CardRef["location"], seq: number, mine: boolean) {
  const s = slot(loc, seq, mine);
  return { x: s.x * S, z: s.y * S };
}
