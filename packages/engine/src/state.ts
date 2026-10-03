import { randomUUID } from "node:crypto";
import type { CardRef, DuelEvent, DuelState, Location, PlayerIdx } from "@ygosim/protocol";
import { OcgLocation as L, OcgMessageType as M, OcgQueryFlags as Q, type OcgCardLoc, type OcgCoreSync, type OcgDuelHandle, type OcgLocPos, type OcgMessage, type OcgQueryFlags } from "ocgcore-wasm";
import type { SqlCardDb } from "./carddb.js";
import { formatCoreText, type SystemStrings } from "./data.js";
import type { SummonMetadata } from "./core.js";

const zones = [L.DECK, L.HAND, L.MZONE, L.SZONE, L.GRAVE, L.REMOVED, L.EXTRA];
const flags = Q.CODE | Q.POSITION | Q.OWNER | Q.ATTACK | Q.DEFENSE | Q.LEVEL | Q.RANK | Q.LINK | Q.COUNTERS | Q.OVERLAY_CARD | Q.IS_PUBLIC | Q.IS_HIDDEN;
const location = (l: number, s: number): Location => {
  if (l & L.MZONE) return s >= 5 ? "emzone" : "mzone";
  if (l & L.SZONE) return s === 5 ? "fzone" : s >= 6 ? "pzone" : "szone";
  return ({ [L.DECK]: "deck", [L.HAND]: "hand", [L.GRAVE]: "grave", [L.REMOVED]: "banished", [L.EXTRA]: "extra", [L.FZONE]: "fzone", [L.PZONE]: "pzone" } as Record<number, Location>)[l] ?? "mzone";
};
const position = (p: number): CardRef["position"] => p & 8 ? "facedown_def" : p & 2 ? "facedown" : p & 4 ? "def" : p & 1 ? "atk" : "facedown";
const rawFaceUp = (p: CardRef["position"]): boolean => p === "atk" || p === "def" || p === "faceup";
const fieldLocation = (l: Location): boolean => l === "mzone" || l === "emzone" || l === "szone" || l === "fzone" || l === "pzone";
const normalizedPosition = (c: Pick<CardRef, "location" | "position">, visible: boolean): CardRef["position"] => {
  if (fieldLocation(c.location)) return c.position;
  if (c.location === "deck") return "facedown";
  if (c.location === "grave") return "faceup";
  if (c.location === "hand") return visible ? "faceup" : "facedown";
  return rawFaceUp(c.position) ? "faceup" : "facedown";
};
const key = (c: Pick<OcgLocPos, "controller" | "location" | "sequence"> & { overlay_sequence?: number }) => `${c.controller}:${c.location}:${c.sequence}:${c.overlay_sequence ?? ""}`;
const clone = <T>(v: T): T => structuredClone(v);
type SummonKind = Extract<DuelEvent, { t: "summon" }>["kind"];
const summonReasons: [number, SummonKind][] = [
  [0x40000, "fusion"], [0x80000, "synchro"], [0x100000, "ritual"],
  [0x200000, "xyz"], [0x10000000, "link"],
];
const summonTypes: [number, SummonKind][] = [
  [0x43000000, "fusion"], [0x45000000, "ritual"], [0x46000000, "synchro"],
  [0x49000000, "xyz"], [0x4a000000, "pendulum"], [0x4c000000, "link"],
];

/** Tracks physical instances separately from their public, viewer-specific identities. */
export class DuelTracker {
  readonly duelId: string;
  turn = 0;
  turnPlayer: PlayerIdx = 0;
  phase: DuelState["phase"] = "draw";
  lp: [number, number];
  chain: DuelState["chain"] = [];
  ended?: { winner: PlayerIdx | null; reason: string };
  private cards = new Map<string, CardRef>();
  private summonMoveReasons = new Map<string, { code: number; reason?: number }>();
  private publicCards = new Set<string>();
  private reversedDeck = false;
  private visibleDeckTop: [boolean, boolean] = [false, false];
  private aliases: [Map<string, string>, Map<string, string>] = [new Map(), new Map()];
  private revealed = new WeakMap<CardRef, number>();
  private confirmed = new Map<string, number>();
  private hintAudience = new WeakMap<DuelEvent, number>();
  constructor(private db: SqlCardDb, private strings: SystemStrings, lp: number, private first: PlayerIdx, duelId: string = randomUUID()) { this.duelId = duelId; this.lp = [lp, lp]; this.turnPlayer = first; }
  player = (p: number): PlayerIdx => (p ^ this.first) as PlayerIdx;

  card = (loc: OcgCardLoc | OcgLocPos): CardRef => {
    const k = key(loc);
    let c = this.cards.get(k);
    if (!c) {
      c = { uid: randomUUID(), code: "code" in loc ? loc.code : undefined, owner: this.player(loc.controller), controller: this.player(loc.controller), location: location(loc.location, loc.sequence), sequence: loc.sequence, position: position("position" in loc ? loc.position : 0) };
      this.cards.set(k, c);
    }
    if ("code" in loc && loc.code) c.code = loc.code & 0x7fffffff;
    if ("position" in loc) c.position = position(loc.position);
    return clone(c);
  };

  refresh(core: OcgCoreSync, handle: OcgDuelHandle) {
    const next = new Map<string, CardRef>();
    this.publicCards.clear();
    for (const controller of [0, 1] as const) for (const zone of zones) {
      const rows = core.duelQueryLocation(handle, { controller, location: zone, flags: flags as OcgQueryFlags });
      rows.forEach((r, sequence) => {
        if (!r || !r.code) return;
        const loc = { controller, location: zone, sequence, code: r.code, position: r.position ?? 0 };
        const c = this.card(loc);
        c.owner = this.player(r.owner ?? controller);
        c.atk = r.attack; c.def = r.defense; c.level = r.link?.rating || r.rank || r.level;
        c.counters = r.counters;
        c.overlays = r.overlayCards?.map((code, i) => {
          const overlay = this.card({ ...loc, code, location: (zone | L.OVERLAY) as typeof zone, overlay_sequence: i });
          const info = core.duelQuery(handle, { controller, location: (zone | L.OVERLAY) as typeof zone, sequence, overlaySequence: i, flags: Q.OWNER });
          if (info?.owner !== undefined) overlay.owner = this.player(info.owner);
          overlay.position = "faceup";
          return overlay;
        });
        if ((r.isPublic || (zone === L.DECK && sequence === rows.length - 1 && (this.reversedDeck || this.visibleDeckTop[controller]))) && !r.isHidden) this.publicCards.add(c.uid);
        next.set(key(loc), c);
      });
    }
    this.cards = next;
  }

  private move(from: OcgLocPos, to: OcgLocPos, code: number): DuelEvent {
    const source = { ...from, controller: from.controller < 2 ? from.controller : to.controller };
    const old = this.card({ ...source, code });
    this.cards.delete(key(source));
    this.confirmed.delete(old.uid);
    // Ordered piles compact when a card leaves; field slots do not.
    if ([L.DECK, L.HAND, L.GRAVE, L.REMOVED, L.EXTRA].includes(from.location as 1)) {
      const shifts = [...this.cards.entries()].filter(([k, c]) => k.startsWith(`${from.controller}:${from.location}:`) && c.sequence > from.sequence);
      for (const [k] of shifts) this.cards.delete(k);
      for (const [, c] of shifts) { c.sequence--; this.cards.set(key({ controller: from.controller, location: from.location, sequence: c.sequence }), c); }
    }
    const c = { ...old, owner: from.location ? old.owner : this.player(to.controller), controller: to.controller < 2 ? this.player(to.controller) : old.controller, location: to.location ? location(to.location, to.sequence) : old.location, sequence: to.location ? to.sequence : old.sequence, position: to.location ? position(to.position) : old.position };
    if (to.location) {
      if ([L.DECK, L.HAND, L.GRAVE, L.REMOVED, L.EXTRA].includes(to.location as 1)) {
        const shifts = [...this.cards.entries()].filter(([k, card]) => k.startsWith(`${to.controller}:${to.location}:`) && card.sequence >= to.sequence);
        for (const [k] of shifts) this.cards.delete(k);
        for (const [, card] of shifts) { card.sequence++; this.cards.set(key({ controller: to.controller, location: to.location, sequence: card.sequence }), card); }
      }
      this.cards.set(key(to), c);
    }
    return { t: "move", card: clone(c), from: from.location ? old : {}, reason: to.location ? "core" : "removed" };
  }

  ingest(m: OcgMessage): DuelEvent[] {
    switch (m.type) {
      case M.NEW_TURN: this.turn++; this.turnPlayer = this.player(m.player); return [{ t: "new_turn", turn: this.turn, turnPlayer: this.turnPlayer }];
      case M.NEW_PHASE: {
        const p: DuelState["phase"] = m.phase === 1 ? "draw" : m.phase === 2 ? "standby" : m.phase === 4 ? "main1" : m.phase === 256 ? "main2" : m.phase === 512 ? "end" : "battle";
        this.phase = p; return [{ t: "phase", phase: p, turnPlayer: this.turnPlayer }];
      }
      case M.MOVE: {
        this.summonMoveReasons.delete(key(m.from));
        this.summonMoveReasons.delete(key(m.to));
        const reason = (m as typeof m & SummonMetadata).reason;
        if ((m.to.location & L.MZONE) !== 0) {
          this.summonMoveReasons.set(key(m.to), { code: m.card & 0x7fffffff, reason });
        }
        return [this.move(m.from, m.to, m.card)];
      }
      case M.DRAW: {
        const drawn = m.drawn.map(c => {
          const deck = [...this.cards.values()].filter(c => c.controller === this.player(m.player) && c.location === "deck");
          const hand = [...this.cards.values()].filter(c => c.controller === this.player(m.player) && c.location === "hand");
          return (this.move({ controller: m.player as PlayerIdx, location: L.DECK, sequence: Math.max(0, deck.length - 1), position: 8 }, { controller: m.player as PlayerIdx, location: L.HAND, sequence: hand.length, position: c.position }, c.code) as Extract<DuelEvent, {t:"move"}>).card;
        });
        return [{ t: "draw", player: this.player(m.player), cards: drawn }];
      }
      case M.SET: return (m.location & L.MZONE) !== 0 ? [{ t: "summon", card: this.card(m), kind: "set" }] : [];
      case M.SUMMONING: return [{ t: "summon", card: this.card(m), kind: "normal" }];
      case M.FLIPSUMMONING: return [{ t: "summon", card: this.card(m), kind: "flip" }];
      case M.SPSUMMONING: {
        const card = this.card(m);
        const moved = this.summonMoveReasons.get(key(m));
        this.summonMoveReasons.delete(key(m));
        const source = moved?.code === card.code ? moved : undefined;
        const { reason: summonReason, summonType } = m as typeof m & SummonMetadata;
        const reason = summonReason ?? source?.reason;
        const kind = summonType !== undefined
          ? summonTypes.find(([type]) => (summonType & 0xff000000) === type)?.[1] ?? "special"
          : reason !== undefined
            ? summonReasons.find(([flag]) => (reason & flag) !== 0)?.[1] ?? "special"
            : "special";
        return [{ t: "summon", card, kind }];
      }
      case M.POS_CHANGE: return [{ t: "pos_change", card: this.card(m) }];
      case M.CHAINING: {
        const c = this.card(m); this.revealed.set(c, 3);
        this.chain.push({ card: c, desc: formatCoreText(this.db.effectString(m.description) ?? this.strings.system.get(Number(m.description)) ?? this.db.name(m.code), this.db.name(m.code)) });
        return [{ t: "activate", card: c, chainLink: m.chain_size }];
      }
      case M.BECOME_TARGET: {
        const link = this.chain.at(-1);
        if (link) {
          link.targets ??= [];
          for (const loc of m.cards) {
            const target = this.card(loc);
            if (!link.targets.some(c => c.uid === target.uid)) link.targets.push(target);
          }
        }
        return [];
      }
      case M.CHAIN_SOLVED: return [{ t: "chain_solved", chainLink: m.chain_size }];
      case M.CHAIN_END: this.chain = []; return [];
      case M.ATTACK: return [{ t: "attack", attacker: this.card(m.card), ...(m.target ? { target: this.card(m.target) } : {}) }];
      case M.DAMAGE: case M.PAY_LPCOST: case M.RECOVER: {
        const p = this.player(m.player); const recovering = m.type === M.RECOVER; const paying = m.type === M.PAY_LPCOST;
        this.lp[p] = Math.max(0, this.lp[p] + (recovering ? m.amount : -m.amount));
        return [{ t: recovering ? "recover" : paying ? "pay_lp" : "damage", player: p, amount: m.amount, lp: this.lp[p] }];
      }
      case M.LPUPDATE: {
        const p = this.player(m.player), delta = m.lp - this.lp[p]; this.lp[p] = m.lp;
        return delta === 0 ? [] : [{ t: delta > 0 ? "recover" : "damage", player: p, amount: Math.abs(delta), lp: m.lp }];
      }
      case M.SHUFFLE_DECK: case M.SHUFFLE_HAND: case M.SHUFFLE_EXTRA: {
        const zone = m.type === M.SHUFFLE_DECK ? "deck" : m.type === M.SHUFFLE_HAND ? "hand" : "extra";
        for (const [k, c] of this.cards) if (c.controller === this.player(m.player) && c.location === zone && !(zone === "extra" && rawFaceUp(c.position))) { this.cards.delete(k); this.confirmed.delete(c.uid); }
        return [{ t: "shuffle", player: this.player(m.player), location: zone }];
      }
      case M.REVERSE_DECK: {
        this.reversedDeck = !this.reversedDeck;
        for (const controller of [0, 1] as const) {
          const cards = [...this.cards.entries()].filter(([k]) => k.startsWith(`${controller}:${L.DECK}:`));
          for (const [k] of cards) this.cards.delete(k);
          for (const [, c] of cards) { c.sequence = cards.length - 1 - c.sequence; this.cards.set(key({ controller, location: L.DECK, sequence: c.sequence }), c); }
        }
        return [{ t: "hint", text: "Deck order reversed" }];
      }
      case M.DECK_TOP: {
        this.visibleDeckTop[m.player as PlayerIdx] = (m.position & 5) !== 0;
        if (!m.code) return [];
        const count = [...this.cards.values()].filter(c => c.controller === this.player(m.player) && c.location === "deck").length;
        const c = this.card({ controller: m.player as PlayerIdx, location: L.DECK, sequence: Math.max(0, count - 1 - m.count), code: m.code, position: m.position });
        this.revealed.set(c, 3);
        return [{ t: "move", card: c, from: { location: "deck", sequence: c.sequence }, reason: "reveal" }];
      }
      case M.SHUFFLE_SET_CARD: {
        const cards = m.cards.map(c => this.card(c.from));
        for (const c of m.cards) this.cards.delete(key(c.from));
        for (const c of cards) this.confirmed.delete(c.uid);
        const players = new Set(cards.map(c => c.controller));
        return [...players].map(player => ({ t: "shuffle", player, location: location(m.location, 0) }));
      }
      case M.SWAP: {
        const c1 = this.card(m.card1), c2 = this.card(m.card2);
        this.cards.delete(key(m.card1)); this.cards.delete(key(m.card2));
        this.cards.set(key(m.card2), { ...c1, controller: c2.controller, location: c2.location, sequence: c2.sequence, position: c2.position });
        this.cards.set(key(m.card1), { ...c2, controller: c1.controller, location: c1.location, sequence: c1.sequence, position: c1.position });
        return [{ t: "move", card: this.card(m.card2), from: c1, reason: "swap" }, { t: "move", card: this.card(m.card1), from: c2, reason: "swap" }];
      }
      case M.ADD_COUNTER: case M.REMOVE_COUNTER: {
        const c = this.cards.get(key(m)); if (c) { c.counters ??= {}; const k = String(m.counter_type); c.counters[k] = Math.max(0, (c.counters[k] ?? 0) + (m.type === M.ADD_COUNTER ? m.count : -m.count)); }
        return [];
      }
      case M.CONFIRM_CARDS: case M.CONFIRM_DECKTOP: case M.CONFIRM_EXTRATOP:
        return m.cards.map(loc => { const c = this.card(loc); this.revealed.set(c, 1 << this.player(m.player)); this.confirmed.set(c.uid, (this.confirmed.get(c.uid) ?? 0) | (1 << this.player(m.player))); return { t: "move", card: c, from: { location: c.location, sequence: c.sequence }, reason: "reveal" }; });
      case M.WIN: this.ended = { winner: m.player < 2 ? this.player(m.player) : null, reason: this.strings.victory.get(m.reason) ?? `Core victory reason ${m.reason}` }; return [{ t: "win", ...this.ended }];
      case M.SHOW_HINT: { const e: DuelEvent = { t: "hint", text: formatCoreText(m.hint) }; return [e]; }
      case M.HINT: {
        // Choice hints may identify private cards. Deliver only to their recipient.
        const text = this.strings.system.get(Number(m.hint));
        if (!text) return [];
        const e: DuelEvent = { t: "hint", text: formatCoreText(text) }; this.hintAudience.set(e, m.player < 2 ? 1 << this.player(m.player) : 3); return [e];
      }
      default: return [];
    }
  }

  private visible(c: CardRef, viewer: PlayerIdx) {
    if (this.publicCards.has(c.uid)) return true;
    if (c.location === "deck") return false;
    if (c.location === "grave") return true;
    return c.controller === viewer || rawFaceUp(c.position);
  }
  private redact(c: CardRef, viewer: PlayerIdx, event = false): CardRef {
    const out = clone(c);
    const visible = event
      ? ((this.revealed.get(c) ?? 0) & (1 << viewer)) !== 0 || (c.location !== "deck" && (c.location === "grave" || c.controller === viewer || rawFaceUp(c.position)))
      : this.visible(c, viewer);
    out.position = normalizedPosition(c, visible);
    if (!visible) { delete out.code; delete out.atk; delete out.def; delete out.level; delete out.counters; delete out.overlays; }
    // Viewers cannot follow identities through hidden piles or subsequent shuffles.
    const maskIdentity = !visible && (c.location === "deck" || (c.controller !== viewer && (c.location === "hand" || c.location === "extra" || !rawFaceUp(c.position))));
    if (maskIdentity) {
      const slot = `${c.controller}:${c.location}:${c.sequence}`;
      let id = this.aliases[viewer].get(slot); if (!id) { id = randomUUID(); this.aliases[viewer].set(slot, id); }
      out.uid = id;
    }
    if (out.overlays) out.overlays = c.overlays!.map(o => this.redact(o, viewer, event));
    return out;
  }
  promptCard(loc: OcgCardLoc, player: number): CardRef {
    const card = this.card(loc);
    const viewer = this.player(player);
    // The core offers these private cards to their controller to make a choice.
    // This grants visibility for this option only, never for the whole Deck.
    if ((card.controller === viewer && ["deck", "extra", "hand"].includes(card.location)) || ((this.confirmed.get(card.uid) ?? 0) & (1 << viewer))) return card;
    // A nonzero core prompt code alone cannot reveal an opponent's hidden card.
    return this.redact(card, viewer);
  }
  promptCardByCode(code: number, player: number): CardRef | undefined {
    const candidates = [...this.cards.values()].filter(c => c.code === (code & 0x7fffffff));
    const cards = candidates.map(c => this.redact(c, this.player(player)));
    // Code-only decisions provide no instance location. Fail closed when the
    // identity could refer to a hidden copy, or the instance is not tracked.
    return cards.length === 1 || (cards.length && cards.every(c => c.code !== undefined)) ? cards[0] : undefined;
  }
  /** Redact only the chain when rendering a response prompt. */
  chainFor(viewer: PlayerIdx): DuelState["chain"] {
    return this.chain.map(c => ({ card: this.redact(c.card, viewer, true), desc: c.desc, ...(c.targets ? { targets: c.targets.map(target => ((this.confirmed.get(target.uid) ?? 0) & (1 << viewer)) ? clone(target) : this.redact(target, viewer)) } : {}) }));
  }
  stateFor(viewer: PlayerIdx): DuelState {
    return { duelId: this.duelId, turn: this.turn, turnPlayer: this.turnPlayer, phase: this.phase, lp: [...this.lp], cards: [...this.cards.values()].map(c => this.redact(c, viewer)), chain: this.chainFor(viewer), you: viewer };
  }
  redactEvents(events: DuelEvent[], viewer: PlayerIdx): DuelEvent[] {
    return events.filter(e => !this.hintAudience.has(e) || ((this.hintAudience.get(e)! & (1 << viewer)) !== 0)).map(e => {
      switch (e.t) {
        case "draw": return { ...e, cards: e.cards.map(c => this.redact(c, viewer, true)) };
        case "move": { const from = e.from.uid ? this.redact(e.from as CardRef, viewer, true) : clone(e.from); return { ...e, card: this.redact(e.card, viewer, true), from }; }
        case "summon": case "activate": case "pos_change": return { ...e, card: this.redact(e.card, viewer, true) };
        case "attack": return { ...e, attacker: this.redact(e.attacker, viewer, true), ...(e.target ? { target: this.redact(e.target, viewer, true) } : {}) };
        default: return clone(e);
      }
    });
  }
}
