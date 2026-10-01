import type { CardRef, Duel, DuelEvent, DuelState } from "@ygosim/protocol";

function hidden(card: Partial<CardRef>): boolean {
  return card.location === "hand" || card.location === "deck"
    || card.position === "facedown" || card.position === "facedown_def"
    || (card.location === "extra" && card.position !== "faceup" && card.position !== "atk" && card.position !== "def");
}

/** Neutral visibility is independent of ownership and explicit player reveals. */
function cardForSpectator<T extends Partial<CardRef>>(card: T, conceal = false): T {
  const out = { ...card };
  conceal ||= hidden(card);
  if (conceal) {
    delete out.code;
    delete out.atk;
    delete out.def;
    delete out.level;
    delete out.counters;
  }
  if (card.overlays) out.overlays = card.overlays.map(c => cardForSpectator(c, conceal));
  return out;
}

export function spectatorState(duel: Duel): DuelState {
  const state = duel.stateFor(0);
  return {
    ...state,
    cards: state.cards.map(c => cardForSpectator(c)),
    chain: state.chain.map(link => ({ card: cardForSpectator(link.card), desc: hidden(link.card) ? "" : link.desc })),
  };
}

export function spectatorEvents(duel: Duel, events: DuelEvent[]): DuelEvent[] {
  // Preserve the engine's audience filtering: private hints are never broadcast.
  const publicEvents = events.filter(e => e.t !== "hint" || duel.redactEvents([e], 1).length > 0);
  return duel.redactEvents(publicEvents, 0).map(e => {
    switch (e.t) {
      case "draw": return { ...e, cards: e.cards.map(c => cardForSpectator(c, true)) };
      case "move": return { ...e, card: cardForSpectator(e.card), from: cardForSpectator(e.from, e.from.location === undefined) };
      case "summon": return { ...e, card: cardForSpectator(e.card, e.kind === "set") };
      case "activate": case "pos_change": return { ...e, card: cardForSpectator(e.card) };
      case "attack": return { ...e, attacker: cardForSpectator(e.attacker), ...(e.target ? { target: cardForSpectator(e.target) } : {}) };
      default: return { ...e };
    }
  });
}
