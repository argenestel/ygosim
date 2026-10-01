import type { Action, CardRef, DuelState, Prompt, PromptOption } from "@ygosim/protocol";
import { bounds, cardAtk, legalize, text, type Bot } from "./bot.js";

/**
 * Heuristic bot. Scores each option, picks the best `min..max` options.
 * Works purely off option ids/labels and attached cards, so it is engine-agnostic.
 */
export class NormalBot implements Bot {
  readonly name: string = "NormalBot";

  choose(state: DuelState, p: Prompt): Action {
    const { min, max } = bounds(p);
    if (p.options.length === 0) return legalize(p, undefined);
    const scored = p.options
      .map((o, i) => ({ o, s: this.score(state, p, o) - i * 1e-6 }))
      .sort((a, b) => b.s - a.s);
    // Take the minimum required (at least one when allowed), best-scored first.
    let pick: PromptOption[] = scored.slice(0, Math.max(min, Math.min(1, max))).map((x) => x.o);
    if (min === 0 && pick.length && scored[0]!.s <= 0) pick = [];
    return legalize(p, { promptId: p.promptId, choose: pick.map((o) => o.id) });
  }

  protected oppMonsters(state: DuelState): CardRef[] {
    return state.cards.filter((c) => c.controller !== state.you && c.location === "mzone");
  }
  protected myMonsters(state: DuelState): CardRef[] {
    return state.cards.filter((c) => c.controller === state.you && c.location === "mzone");
  }
  protected bestOppStat(state: DuelState): number {
    return Math.max(0, ...this.oppMonsters(state).map((c) => (c.position === "atk" ? cardAtk(c) : c.def ?? 1500)));
  }

  /** Higher is better. */
  score(state: DuelState, p: Prompt, o: PromptOption): number {
    const t = text(o);
    const atk = cardAtk(o.card);
    switch (p.kind) {
      case "idle": {
        if (/summon|normal/.test(t) && !/special|set/.test(t)) return 80 + atk / 100;
        if (/special|fusion|synchro|xyz|link|ritual|pendulum/.test(t)) return 90 + atk / 100;
        if (/activate|effect/.test(t)) return 70;
        if (/set/.test(t)) {
          const isMonster = o.card?.location === "hand" && o.card?.atk !== undefined;
          return isMonster ? 30 + (o.card?.def ?? 0) / 200 : 50;
        }
        if (/battle/.test(t)) {
          const mine = this.myMonsters(state).filter((c) => c.position === "atk");
          return mine.length && state.turn > 1 ? 40 : -10;
        }
        if (/reposition|position|pos/.test(t)) return 5;
        if (/end|phase/.test(t)) return 0;
        return 10;
      }
      case "battle_idle": {
        if (/attack/.test(t)) {
          const best = this.bestOppStat(state);
          return atk > best || this.oppMonsters(state).length === 0 ? 60 + atk / 100 : -20;
        }
        if (/activate/.test(t)) return 30;
        if (/main|end|phase/.test(t)) return 0;
        return 5;
      }
      case "select_card":
      case "select_tribute": {
        // Prefer an actual selection over canceling and retrying the same summon.
        if (o.id === "finish") return 10_000;
        if (o.id === "cancel" || o.id.startsWith("unselect:")) return -10_000;
        // Prefer opponent's strong cards as targets; tribute own weakest.
        if (!o.card) return 0;
        const own = o.card.controller === state.you;
        return own ? -atk / 100 : atk / 100 + 10;
      }
      case "select_chain":
      case "select_effect_yn":
        return /no|pass|cancel|don't/.test(t) ? 0 : 20;
      case "select_yesno":
        return /yes/.test(t) ? 10 : 0;
      case "select_position":
        if (/facedown|set/.test(t)) return atk < this.bestOppStat(state) ? 15 : 0;
        if (/atk|attack/.test(t)) return atk >= this.bestOppStat(state) ? 20 : 5;
        return 8;
      case "first_turn":
        return /first|go/.test(t) ? 1 : 0;
      default:
        return 0;
    }
  }
}
