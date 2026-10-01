import type { Action, DuelState, Prompt, PromptOption, CardRef } from "@ygosim/protocol";

export type AiLevel = "easy" | "normal" | "hard";

/** Pluggable bot: given the (redacted) state and a prompt, return a legal action. */
export interface Bot {
  readonly name: string;
  choose(state: DuelState, prompt: Prompt): Action | Promise<Action>;
}

export function bounds(p: Prompt): { min: number; max: number } {
  const n = p.options.length;
  const min = Math.min(Math.max(p.min ?? 1, 0), n);
  const max = Math.max(Math.min(p.max ?? Math.max(min, 1), n), min);
  return { min, max };
}

/** True if an action is a structurally legal answer to the prompt. */
export function isLegal(p: Prompt, a: Action): boolean {
  if (!a || a.promptId !== p.promptId || !Array.isArray(a.choose)) return false;
  const { min, max } = bounds(p);
  if (a.choose.length < min || a.choose.length > max) return false;
  const ids = new Set(p.options.map((o) => o.id));
  if (new Set(a.choose).size !== a.choose.length) return false;
  return a.choose.every((c) => typeof c === "string" && ids.has(c));
}

const PASSIVE = /\b(pass|cancel|no|end|skip|done|finish|decline|don't)\b/i;

/** Safe default used on timeout: passive option when single-choice, else first `min` options. */
export function defaultAction(p: Prompt): Action {
  const { min } = bounds(p);
  if (min === 0) return { promptId: p.promptId, choose: [] };
  if (min === 1) {
    const passive =
      p.kind === "idle" || p.kind === "battle_idle"
        ? p.options.find((o) => /end|phase|pass/i.test(o.id + " " + o.label))
        : p.options.find((o) => PASSIVE.test(o.id) || PASSIVE.test(o.label));
    if (passive && p.kind !== "rps" && p.kind !== "first_turn") return { promptId: p.promptId, choose: [passive.id] };
  }
  return { promptId: p.promptId, choose: p.options.slice(0, Math.max(min, 1)).map((o) => o.id) };
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
