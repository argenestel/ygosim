import type { Action, DuelState, Prompt } from "@ygosim/protocol";
import { generateLegalSelections } from "@ygosim/protocol";
import { type Bot } from "./bot.js";

export class EasyBot implements Bot {
  readonly name = "EasyBot";
  constructor(private rng: () => number = Math.random) {}
  choose(_state: DuelState, p: Prompt): Action {
    const pool = [...p.options];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    const candidates = generateLegalSelections({ ...p, options: pool }).candidates;
    if (!candidates.length) throw new Error("no acceptable action within selection search budget");
    const forward = p.constraints?.kind === "interactive" ? candidates.filter(ids => ids[0] === "finish" || ids[0]?.startsWith("select:")) : candidates;
    const choices = forward.length ? forward : candidates;
    return { promptId: p.promptId, choose: choices[Math.floor(this.rng() * choices.length)]! };
  }
}
