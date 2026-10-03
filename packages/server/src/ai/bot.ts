import type { Action, DuelState, Prompt, PromptOption, CardRef } from "@ygosim/protocol";
import { generateLegalSelections, validateSelection } from "@ygosim/protocol";

export type AiLevel = "easy" | "normal" | "hard";

/** Pluggable bot: given the (redacted) state and a prompt, return a legal action. */
export interface Bot {
  readonly name: string;
  choose(state: DuelState, prompt: Prompt): Action | Promise<Action>;
}

export function bounds(p: Prompt): { min: number; max: number } {
  const min = Math.max(p.min ?? 1, 0);
  const max = p.max ?? 1;
  return { min, max };
}

export function isLegal(p: Prompt, a: Action): boolean {
  if (!a || a.promptId !== p.promptId || !Array.isArray(a.choose)) return false;
  return a.choose.every((c) => typeof c === "string") && validateSelection(p, a.choose).valid;
}

const PASSIVE = /\b(pass|cancel|no|end|skip|done|finish|decline|don't)\b/i;

export function defaultAction(p: Prompt): Action {
  const candidates = generateLegalSelections(p).candidates;
  if (!candidates.length) throw new Error("no acceptable action within selection search budget");
  if (p.constraints?.kind !== "interactive") {
    const passive =
      p.kind === "idle" || p.kind === "battle_idle"
        ? p.options.find((o) => /end|phase|pass/i.test(o.id + " " + o.label))
        : p.options.find((o) => PASSIVE.test(o.id) || PASSIVE.test(o.label));
    if (passive && p.kind !== "rps" && p.kind !== "first_turn" && validateSelection(p, [passive.id]).valid) return { promptId: p.promptId, choose: [passive.id] };
  }
  return { promptId: p.promptId, choose: candidates[0]! };
}

/** Coerce any candidate into a legal action (falls back to defaultAction). */
export function legalize(p: Prompt, a: Action | undefined): Action {
  if (a && isLegal(p, a)) return a;
  return defaultAction(p);
}

export function text(o: PromptOption): string {
  return `${o.id} ${o.label}`.toLowerCase();
}

export function cardAtk(c?: CardRef): number {
  return c?.atk ?? 0;
}
