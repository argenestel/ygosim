import type { Action, DuelState, Prompt } from "@ygosim/protocol";
import { bounds, legalize, type Bot } from "./bot.js";

/** Picks a uniformly random legal action. */
export class EasyBot implements Bot {
  readonly name = "EasyBot";
  constructor(private rng: () => number = Math.random) {}
  choose(_state: DuelState, p: Prompt): Action {
    const { min, max } = bounds(p);
    const count = min + Math.floor(this.rng() * (max - min + 1));
    const pool = [...p.options];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    return legalize(p, { promptId: p.promptId, choose: pool.slice(0, count).map((o) => o.id) });
  }
}
