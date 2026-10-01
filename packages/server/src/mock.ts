import type { Action, Deck, Duel, DuelEvent, DuelState, Prompt, StepResult, PlayerIdx } from "@ygosim/protocol";

/**
 * MockDuel for testing: simulates a simple bot-vs-bot game without the engine.
 * Bots play basic moves that allow testing room flow and AI logic.
 */
export class MockDuel implements Duel {
  private state: DuelState;
  private pendingPrompt?: { player: PlayerIdx; prompt: Prompt };
  private turn = 0;
  private maxTurns = 20;
  private phase: DuelState["phase"] = "draw";
  private events: DuelEvent[] = [];

  constructor(decks: [Deck, Deck], seed?: number) {
    this.state = {
      duelId: `mock-${Math.random()}`,
      turn: 1,
      turnPlayer: 0,
      phase: "draw",
      lp: [8000, 8000],
      cards: [],
      chain: [],
      you: 0,
    };
  }

  async step(): Promise<StepResult> {
    this.events = [];
    this.turn++;

    // Simple game loop: alternate between players asking for idle actions
    if (this.turn > this.maxTurns) {
      return {
        events: [{ t: "win", winner: null, reason: "turn limit" }],
        ended: { winner: null, reason: "turn limit" },
      };
    }

    const player: PlayerIdx = this.turn % 2 === 0 ? 1 : 0;
    this.state.turnPlayer = player;
    this.state.turn = Math.ceil(this.turn / 2);
    this.state.phase = "main1";

    this.events.push({ t: "new_turn", turn: this.state.turn, turnPlayer: player });
    this.events.push({ t: "phase", phase: "main1", turnPlayer: player });

    const prompt: Prompt = {
      promptId: `p${this.turn}`,
      kind: "idle",
      text: "Choose an action",
      min: 1,
      max: 1,
      options: [
        { id: "end", label: "End Turn" },
        { id: "summon", label: "Summon a monster" },
        { id: "activate", label: "Activate a spell" },
      ],
    };

    this.pendingPrompt = { player, prompt };
    return { events: this.events, pending: { player, prompt } };
  }

  respond(player: PlayerIdx, action: Action): void {
    if (!this.pendingPrompt || this.pendingPrompt.player !== player) {
      throw new Error("No pending prompt for this player");
    }
    if (action.promptId !== this.pendingPrompt.prompt.promptId) {
      throw new Error("Wrong prompt ID");
    }
    if (!action.choose.includes("end") && !action.choose.includes("summon") && !action.choose.includes("activate")) {
      throw new Error("Invalid action");
    }
    this.pendingPrompt = undefined;
  }

  stateFor(viewer: PlayerIdx): DuelState {
    return { ...this.state, you: viewer };
  }

  redactEvents(events: DuelEvent[], viewer: PlayerIdx): DuelEvent[] {
    // In a real implementation, hide opponent's hand cards
    return events;
  }

  destroy(): void {
    this.pendingPrompt = undefined;
  }
}
