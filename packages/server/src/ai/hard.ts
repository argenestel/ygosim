import type { CardRef, DuelState, Prompt, PromptOption } from "@ygosim/protocol";
import { cardAtk, text } from "./bot.js";
import { NormalBot } from "./normal.js";

/**
 * Normal heuristics + a 1-ply evaluation of the board after a candidate battle
 * action (damage/destruction outcome) and lethal detection. Engine snapshots are
 * not cloneable, so the lookahead is simulated over the visible state.
 */
export class HardBot extends NormalBot {
  override readonly name = "HardBot";

  evaluate(state: DuelState): number {
    const me = state.you, opp = (1 - me) as 0 | 1;
    const mon = (pl: number) => state.cards.filter((c) => c.controller === pl && c.location === "mzone")
      .reduce((s, c) => s + cardAtk(c) + 300, 0);
    const hand = (pl: number) => state.cards.filter((c) => c.controller === pl && c.location === "hand").length;
    return state.lp[me] - state.lp[opp] + (mon(me) - mon(opp)) * 0.8 + (hand(me) - hand(opp)) * 400;
  }

  simulateAttack(state: DuelState, attacker: CardRef, target?: CardRef): DuelState {
    const s: DuelState = { ...state, lp: [...state.lp] as [number, number], cards: [...state.cards] };
    const opp = (1 - state.you) as 0 | 1;
    const a = cardAtk(attacker);
    const remove = (c: CardRef) => (s.cards = s.cards.filter((x) => x.uid !== c.uid));
    if (!target) { s.lp[opp] -= a; return s; }
    if (target.position === "atk") {
      const d = cardAtk(target);
      if (a > d) { remove(target); s.lp[opp] -= a - d; }
      else if (a < d) { remove(attacker); s.lp[state.you] -= d - a; }
      else { remove(target); remove(attacker); }
    } else {
      const d = target.def ?? 1500; // facedown: guess
      if (a > d) remove(target); else if (a < d) s.lp[state.you] -= d - a;
    }
    return s;
  }

  override score(state: DuelState, p: Prompt, o: PromptOption): number {
    const base = super.score(state, p, o);
    const t = text(o);
    const opp = (1 - state.you) as 0 | 1;
    if (p.kind === "battle_idle" && /attack/.test(t) && o.card) {
      const opps = this.oppMonsters(state);
      if (opps.length === 0) return 200 + (cardAtk(o.card) >= state.lp[opp] ? 1000 : 0);
      const before = this.evaluate(state);
      const best = Math.max(...opps.map((tg) => this.evaluate(this.simulateAttack(state, o.card!, tg)) - before));
      return best > 0 ? 100 + best / 100 : -50;
    }
    if (p.kind === "select_card" && o.card && o.card.controller !== state.you && o.card.location === "mzone") {
      // Likely attack/effect target: pick the one giving the best outcome.
      return base + (o.card.position === "atk" ? 5 : 0);
    }
    if (p.kind === "idle" && /battle/.test(t)) {
      const mine = this.myMonsters(state).filter((c) => c.position === "atk");
      const lethal = this.oppMonsters(state).length === 0 && mine.reduce((s, c) => s + cardAtk(c), 0) >= state.lp[opp];
      if (lethal && state.turn > 1) return 1000;
    }
    return base;
  }
}
