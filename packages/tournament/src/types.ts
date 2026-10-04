import type { ServerMsg } from '@ygosim/protocol';

export type Cli = "codex" | "pi" | "claude";
export type GameStage = "round-robin" | "final";
export type GameStatus = "pending" | "running" | "done" | "error";
export type TournamentStatus = "running" | "done";
export type DeckSource = "sample" | "custom";

export interface Player {
  id: string;
  label: string;
  cli: Cli;
  model: string;
  effort?: string;
}

export interface DeckInfo {
  name: string;
  source: DeckSource;
  reason: string;
  main: number[];
  extra: number[];
}

export interface GameStats {
  decisions: number;
  avgDecisionMs: number;
  invalid: number;
  toolCalls: number;
  resumes: number;
  reasonsGiven: number;
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
}

export interface Tournament {
  id: string;
  name: string;
  createdAt: string;
  status: TournamentStatus;
  format: "round-robin+final";
  players: Player[];
  games: Game[];
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
  ms: number;
}

export interface ToolCall {
  t: number;
  tool: string;
  args: Record<string, any>;
  ok: boolean;
  ms: number;
  resultPreview?: string;
}
