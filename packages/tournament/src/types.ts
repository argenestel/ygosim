import type { ServerMsg } from '@ygosim/protocol';

export type Cli = "codex" | "pi" | "claude";
export type GameStage = "round-robin" | "final" | "series";
export type GameStatus = "pending" | "running" | "done" | "error";
export type TournamentStatus = "running" | "done";
export type DeckSource = "sample" | "custom";
export type DeckPolicy = "choice" | "custom-only";

export interface Player {
  id: string;
  label: string;
  cli: Cli;
  model: string;
  effort?: string;
  /** Opt in to Codex code mode for models that require it to reach MCP tools. */
  codeMode?: boolean;
}

export interface DeckInfo {
  name: string;
  source: DeckSource;
  reason: string;
  main: number[];
  extra: number[];
  side?: number[];
  fingerprint?: string;
}

export interface GameStats {
  decisions: number;
  avgDecisionMs: number;
  invalid: number;
  toolCalls: number;
  resumes: number;
  reasonsGiven: number;
  timedDecisions?: number;
  latencyKind?: "response";
}

export interface Game {
  id: string;
  stage: GameStage;
  round: number;
  seats: [string, string];
  status: GameStatus;
  winner: string | null;
  reason?: string;
  startedAt?: string;
  endedAt?: string;
  turns?: number;
  decks: Record<string, DeckInfo>;
  stats: Record<string, GameStats>;
  error?: string;
  seed?: number;
  cycle?: number;
  attempt?: number;
  models?: Record<string, string>;
  efforts?: Record<string, string>;
}

export interface Tournament {
  id: string;
  name: string;
  createdAt: string;
  status: TournamentStatus;
  format: "round-robin+final" | "best-of-three";
  players: Player[];
  games: Game[];
  scored?: boolean;
  deckPolicy?: DeckPolicy;
  audit?: {
    revision: string;
    sourceHash: string;
    dirty: boolean;
    node: string;
    cliVersions: Record<string, string>;
    server: string;
    decisionTimeoutMs: number;
    maxInvalid: number;
    maxMinutes?: number;
    seed: number;
    cycles: number;
    mirrored: boolean;
    validatedBy?: string;
    deckPolicy?: DeckPolicy;
  };
  validation?: { passed: boolean; checkedPlayers: string[]; missingPlayers: string[] };
  series?: { bestOf: 3; seed: number; wins: Record<string, number>; winner: string | null; complete: boolean };
}

export interface Standing {
  id: string;
  label: string;
  model: string;
  elo: number;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  points: number;
  winRate: number;
  avgTurns: number;
  avgDecisionMs: number;
  invalidRate: number;
  reasonRate: number;
  crashes: number;
  decks: { name: string; played: number; wins: number }[];
}

export interface DeckStat {
  name: string;
  source: DeckSource;
  picks: number;
  wins: number;
  pickedBy: Record<string, number>;
}

export interface Leaderboard {
  players: Standing[];
  decks: DeckStat[];
  updatedAt: string;
}

export interface ReplayMessage {
  t: number;
  msg: ServerMsg;
}

export interface Decision {
  t: number;
  turn: number;
  phase: string;
  promptId: string;
  promptKind: string;
  options: string[];
  choose: (string | number)[];
  reason: string;
  ms?: number;
  toolMs?: number;
  latencyKind?: "response";
  optionIds?: string[];
  selected?: string[];
}

export interface ToolCall {
  t: number;
  tool: string;
  args: Record<string, any>;
  ok: boolean;
  ms: number;
  resultPreview?: string;
}
