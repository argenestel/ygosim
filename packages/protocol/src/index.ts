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
  | { type: "create_room"; vsAI?: boolean; aiLevel?: "easy" | "normal" | "hard"; deck: Deck; format?: FormatId; match?: MatchType; opponent?: OpponentSpec; spectateOnly?: boolean; opponentDeck?: Deck }
  | { type: "join_room"; roomId: string; deck: Deck }
  | { type: "action"; action: Action }
  | { type: "chat"; text: string }
  | { type: "surrender" }
  | { type: "side_deck"; deck: Deck }    // between games of a match
  | { type: "spectate"; roomId: string };

export type ServerMsg =
  | { type: "welcome"; clientId: string }
  | { type: "room"; roomId: string; players: string[]; status: "waiting" | "dueling" | "siding" | "done"; format?: FormatId; match?: MatchType; score?: [number, number]; game?: number }
  | { type: "events"; events: DuelEvent[]; state: DuelState }
  | { type: "prompt"; prompt: Prompt; state: DuelState }
  | { type: "chat"; from: string; text: string }
  | { type: "agent_status"; seat: PlayerIdx; agent: AgentKind; status: AgentStatus; detail?: string }
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

// ---- Formats / banlists ----
// Banlists come from ProjectIgnis/LFLists (*.lflist.conf). 0 = forbidden, 1 = limited, 2 = semi-limited.
export type FormatId = "tcg" | "ocg" | "traditional" | "unlimited" | "goat" | "edison" | "speed" | string;
export type MatchType = "single" | "match";   // match = best-of-3 with side decking
export interface Format {
  id: FormatId;
  name: string;
  description: string;
  banlist: string;            // banlist name as in the .lflist.conf header (e.g. "2026.07 TCG")
  masterRule: number;         // ocgcore duel rule (1-5)
  startingLp: number;
  startingHand: number;
  drawPerTurn: number;
  deck: { mainMin: number; mainMax: number; extraMax: number; sideMax: number };
  whitelist?: boolean;        // true = only cards listed on the banlist are legal (Goat/Edison)
  traditional?: boolean;      // forbidden cards treated as limited
}
export interface DeckValidation { ok: boolean; errors: string[]; format: FormatId; }
// HTTP: GET /api/formats -> Format[]; GET /api/banlist/:format -> Record<code, 0|1|2>;
//       POST /api/decks/validate { deck, format } -> DeckValidation

// ---- Coding-agent opponents (Claude Code / Codex) ----
// The "AI" a user duels is their own coding agent connected over MCP, either
// launched locally by the server or connected manually with a one-line command.
export type AgentKind = "claude" | "codex" | "bot";
export type AgentStatus = "launching" | "connected" | "thinking" | "idle" | "error" | "exited";
// HTTP:
//   GET  /api/agents -> { agent: AgentKind; installed: boolean; launchable: boolean; connectCommand: string }[]
//   POST /api/agents/launch { roomId, agent, seat? } -> { ok, pid?, error? }   (localhost + YGOSIM_ALLOW_AGENT_LAUNCH only)
//   POST /api/agents/stop { roomId, seat }
// create_room may set `opponent` to reserve the other seat for an agent:
export interface OpponentSpec { kind: AgentKind; level?: "easy" | "normal" | "hard"; launch?: boolean; }
//   ClientMsg create_room gains: opponent?: OpponentSpec; spectateOnly?: boolean (both seats agents/bots, creator watches)
// Card browser:
//   GET  /api/cards?q=&kind=monster|spell|trap&attribute=&race=&level=&sort=name|atk|level&offset=&limit= -> { total, cards: CardData[] }
//   POST /api/cards/resolve { names: string[] } -> { codes: (number|null)[] }   (deck import from text lists)
