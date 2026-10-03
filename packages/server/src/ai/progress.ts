import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Action, DuelEvent, DuelState, Prompt } from "@ygosim/protocol";

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

const diagnosticKey = randomBytes(32);
export function diagnosticFingerprint(value: unknown): string {
  return createHmac("sha256", diagnosticKey).update(JSON.stringify(value) ?? "null").digest("hex");
}

export class BotProgress {
  private board = "";
  private visits = new Map<string, number>();
  private decisions = 0;
  private total = 0;

  constructor(private repeatLimit = 12, private decisionLimit = 512) {}

  observe(states: DuelState[], player: number, prompt: Prompt, events: DuelEvent[] = []): void {
    const board = fingerprint(states);
    if (board !== this.board || events.some(event => event.t === "attack" || event.t === "chain_solved")) {
      this.board = board;
      this.visits.clear();
      this.decisions = 0;
    }
    const key = fingerprint([player, { ...prompt, promptId: undefined }]);
    const count = (this.visits.get(key) ?? 0) + 1;
    this.visits.set(key, count);
    if (count > this.repeatLimit || ++this.decisions > this.decisionLimit || ++this.total > 10000) {
      throw new Error("bot made no progress; start a new duel and report the room reference");
    }
  }
}

export function actionDiagnostic(player: number, prompt: Prompt, action: Action, rejected = false) {
  return { player, kind: prompt.kind, prompt: diagnosticFingerprint(prompt), action: diagnosticFingerprint([prompt.promptId, action.choose]), rejected };
}
