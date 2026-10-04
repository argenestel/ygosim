// Client for the tournament API described in docs/TOURNAMENT.md.
import type { Frame } from "./replay";

export interface TPlayer { id: string; label: string; cli: "codex" | "pi" | "claude"; model: string; effort?: string }
export interface TDeck { name: string; source: "sample" | "custom"; reason: string; main: number[]; extra: number[] }
export interface TStats { decisions: number; avgDecisionMs: number; invalid: number; toolCalls: number; resumes: number; reasonsGiven: number }
export interface TGame {
  id: string; stage: "round-robin" | "final"; round: number; seats: [string, string];
  status: "pending" | "running" | "done" | "error";
  winner: string | null; reason?: string; startedAt?: string; endedAt?: string; turns?: number;
  decks: Record<string, TDeck>; stats: Record<string, TStats>; error?: string;
}
export interface Standing {
  id: string; label: string; model: string; elo: number; played: number; wins: number; losses: number; draws: number;
  points: number; winRate: number; avgTurns: number; avgDecisionMs: number; invalidRate: number; reasonRate: number;
  crashes: number; decks: { name: string; played: number; wins: number }[];
}
export interface DeckStat { name: string; source: "sample" | "custom"; picks: number; wins: number; pickedBy: Record<string, number> }
export interface TSummary { id: string; name: string; createdAt: string; status: "running" | "done"; players: TPlayer[]; done: number; total: number }
export interface Tournament { id: string; name: string; createdAt: string; status: "running" | "done"; format: string; players: TPlayer[]; games: TGame[]; standings: Standing[] }
export interface Leaderboard { players: Standing[]; decks: DeckStat[]; updatedAt: string }
export interface Decision { t: number; turn?: number; phase?: string; promptId?: string; promptKind?: string; options?: string[]; choose: (string | number)[]; reason?: string; ms?: number }

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

const enc = encodeURIComponent;
export const listTournaments = () => get<TSummary[]>("/api/tournaments");
export const getTournament = (tid: string) => get<Tournament>(`/api/tournaments/${enc(tid)}`);
export const getLeaderboard = () => get<Leaderboard>("/api/leaderboard");
export const getReplay = (tid: string, gid: string) => get<Frame[]>(`/api/tournaments/${enc(tid)}/games/${enc(gid)}/replay`);
export const getDecisions = (tid: string, gid: string, pid: string) => get<Decision[]>(`/api/tournaments/${enc(tid)}/games/${enc(gid)}/decisions/${enc(pid)}`);

/** Decision rows may carry epoch or game-relative times; normalise to ms since game start. */
export function relTime(d: Decision, game: TGame): number {
  return d.t > 1e12 && game.startedAt ? d.t - Date.parse(game.startedAt) : d.t;
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;
export const secs = (ms: number) => ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`;
