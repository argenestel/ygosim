// Shared wire contract between engine, server, web client, MCP bridge and AI.
// All packages MUST import types from here. Change only with care.

export type PlayerIdx = 0 | 1;
export type Location =
  | "deck" | "hand" | "mzone" | "szone" | "grave" | "banished" | "extra" | "fzone" | "pzone" | "emzone";

export interface CardRef {
  uid: string;            // stable per-duel instance id
  code?: number;          // passcode; undefined when face-down/hidden to this viewer
  owner: PlayerIdx;
  controller: PlayerIdx;
  location: Location;
  sequence: number;       // zone index
  position: "atk" | "def" | "facedown_def" | "facedown" | "faceup";
  overlays?: CardRef[];   // xyz materials
  counters?: Record<string, number>;
  atk?: number; def?: number; level?: number;
}

export interface CardData {
  code: number; name: string; desc: string;
  type: string[];         // ["Monster","Effect","Synchro"], ["Spell","Quick-Play"], ...
  attribute?: string; race?: string; level?: number; atk?: number; def?: number;
  linkMarkers?: string[]; scale?: number;
  imageUrl: string;       // fetched at runtime (YGOPRODeck CDN), never redistributed
}

export interface DuelState {
  duelId: string;
  turn: number;
  turnPlayer: PlayerIdx;
  phase: "draw" | "standby" | "main1" | "battle" | "main2" | "end";
  lp: [number, number];
  cards: CardRef[];       // already redacted for the viewer
  chain: { card: CardRef; desc: string }[];
  you: PlayerIdx;
}

// A decision the engine is waiting on. Every prompt carries an explicit,
// enumerable option list so humans, bots and LLM agents all act the same way.
export interface Prompt {
  promptId: string;
  kind:
    | "idle" | "battle_idle" | "select_card" | "select_chain" | "select_effect_yn"
    | "select_yesno" | "select_option" | "select_position" | "select_place"
    | "select_tribute" | "select_counter" | "select_sum" | "announce" | "rps" | "first_turn";
  text: string;           // human/LLM-readable description of what is being asked
  min?: number; max?: number;
  options: PromptOption[];
}
export interface PromptOption { id: string; label: string; card?: CardRef; }

export interface Action { promptId: string; choose: string[]; } // option ids

// Animation-friendly events (Master Duel style client replays these in order).
export type DuelEvent =
  | { t: "draw"; player: PlayerIdx; cards: CardRef[] }
  | { t: "move"; card: CardRef; from: Partial<CardRef>; reason: string }
  | { t: "summon"; card: CardRef; kind: "normal" | "set" | "flip" | "special" | "fusion" | "synchro" | "xyz" | "pendulum" | "link" | "ritual" }
  | { t: "activate"; card: CardRef; chainLink: number }
  | { t: "chain_solved"; chainLink: number }
  | { t: "attack"; attacker: CardRef; target?: CardRef }
  | { t: "damage"; player: PlayerIdx; amount: number; lp: number }
  | { t: "recover"; player: PlayerIdx; amount: number; lp: number }
  | { t: "phase"; phase: DuelState["phase"]; turnPlayer: PlayerIdx }
  | { t: "new_turn"; turn: number; turnPlayer: PlayerIdx }
  | { t: "shuffle"; player: PlayerIdx; location: Location }
  | { t: "pos_change"; card: CardRef }
  | { t: "win"; winner: PlayerIdx | null; reason: string }
  | { t: "hint"; text: string };

// ---- WebSocket messages ----
export type ClientMsg =
  | { type: "hello"; name: string; kind: "human" | "agent" }
  | { type: "create_room"; vsAI?: boolean; aiLevel?: "easy" | "normal" | "hard"; deck: Deck }
  | { type: "join_room"; roomId: string; deck: Deck }
  | { type: "action"; action: Action }
  | { type: "chat"; text: string }
  | { type: "surrender" };

export type ServerMsg =
  | { type: "welcome"; clientId: string }
  | { type: "room"; roomId: string; players: string[]; status: "waiting" | "dueling" | "done" }
  | { type: "events"; events: DuelEvent[]; state: DuelState }
  | { type: "prompt"; prompt: Prompt; state: DuelState }
  | { type: "chat"; from: string; text: string }
  | { type: "error"; message: string };

export interface Deck { main: number[]; extra: number[]; side: number[]; }

// ---- Engine interface (implemented by @ygosim/engine, consumed by server) ----
export interface DuelOptions { decks: [Deck, Deck]; seed?: number; startingLp?: number; masterRule?: number; }
export interface StepResult {
  events: DuelEvent[];
  pending?: { player: PlayerIdx; prompt: Prompt };   // undefined only when duel ended
  ended?: { winner: PlayerIdx | null; reason: string };
}
export interface Duel {
  /** Advance the core until it needs a player decision or ends. */
  step(): Promise<StepResult>;
  /** Answer the current pending prompt. Throws on invalid action. */
  respond(player: PlayerIdx, action: Action): void;
  /** Redacted snapshot for a viewer (hidden info removed). */
  stateFor(viewer: PlayerIdx): DuelState;
  /** Events are emitted unredacted; server must call this per viewer. */
  redactEvents(events: DuelEvent[], viewer: PlayerIdx): DuelEvent[];
  destroy(): void;
}
export interface CardDb {
  get(code: number): CardData | undefined;
  search(q: { name?: string; type?: string; limit?: number }): CardData[];
}
