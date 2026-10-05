// Client for the tournament API described in docs/TOURNAMENT.md.
import type { Frame } from "./replay";

export interface TPlayer { id: string; label: string; cli: "codex" | "pi" | "claude"; model: string; effort?: string }
export interface TDeck { name: string; source: "sample" | "custom"; reason: string; main: number[]; extra: number[] }
export interface TStats { decisions: number; avgDecisionMs: number; invalid: number; toolCalls: number; resumes: number; reasonsGiven: number }
export interface TGame {
  id: string; stage: "round-robin" | "final" | "series"; round: number; seats: [string, string];
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
export interface Tournament { id: string; name: string; createdAt: string; status: "running" | "done"; format: string; players: TPlayer[]; games: TGame[]; standings: Standing[]; series?: { bestOf: 3; wins: Record<string, number>; winner: string | null; complete: boolean } }
export interface Leaderboard { players: Standing[]; decks: DeckStat[]; updatedAt: string }
export interface Activity { t: number; tool: string; ok: boolean; ms: number; summary: string }
export interface Decision { t: number; turn?: number; phase?: string; promptId?: string; promptKind?: string; options?: string[]; optionIds?: string[]; choose: (string | number)[]; reason?: string; ms?: number }

const TOKEN_KEY = "ygosim.organizerToken";
/** Organizer token unlocks the raw agent logs; everything else is public. */
export const organizerToken = (): string => { try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } };
export const setOrganizerToken = (t: string) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ } };

async function request(path: string): Promise<Response> {
  const token = organizerToken();
  const r = await fetch(path, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r;
}
async function get<T>(path: string): Promise<T> { return (await request(path)).json() as Promise<T>; }

/** Rows plus the raw server-side count, so tailing with `from` never skips or repeats rows. */
export interface Tail<T> { rows: T[]; total: number }
async function tail<T>(path: string, from: number): Promise<Tail<T>> {
  const r = await request(`${path}${path.includes("?") ? "&" : "?"}from=${from}`);
  const rows = await r.json() as T[];
  const header = r.headers.get("X-Row-Count") ?? r.headers.get("X-Frame-Count");
  const total = header !== null && /^\d+$/.test(header) ? Number(header) : from + rows.length;
  return { rows, total };
}

const enc = encodeURIComponent;
const gamePath = (tid: string, gid: string) => `/api/tournaments/${enc(tid)}/games/${enc(gid)}`;
export const listTournaments = () => get<TSummary[]>("/api/tournaments");
export const getTournament = (tid: string) => get<Tournament>(`/api/tournaments/${enc(tid)}`);
export const getLeaderboard = () => get<Leaderboard>("/api/leaderboard");
export const getReplay = (tid: string, gid: string) => get<Frame[]>(`${gamePath(tid, gid)}/replay`);
export const tailReplay = (tid: string, gid: string, from: number) => tail<Frame>(`${gamePath(tid, gid)}/replay`, from);
export const getDecisions = (tid: string, gid: string, pid: string) => get<Decision[]>(`${gamePath(tid, gid)}/decisions/${enc(pid)}`);
export const tailDecisions = (tid: string, gid: string, pid: string, from: number) => tail<Decision>(`${gamePath(tid, gid)}/decisions/${enc(pid)}`, from);
export const tailActivity = (tid: string, gid: string, pid: string, from: number) => tail<Activity>(`${gamePath(tid, gid)}/activity/${enc(pid)}`, from);
/** Organizer-only raw CLI output (transcript JSONL / stderr), last ~512 KB. */
export const getRawLog = async (tid: string, gid: string, pid: string, kind: "transcript" | "stderr") =>
  (await request(`${gamePath(tid, gid)}/${kind}/${enc(pid)}`)).text();

/** Decision rows may carry epoch or game-relative times; normalise to ms since game start. */
export function relTime(d: Decision, game: TGame): number {
  return d.t > 1e12 && game.startedAt ? d.t - Date.parse(game.startedAt) : d.t;
}

/** Human text for what an agent picked: option labels, resolving 1-based numbers and string ids. */
export const chosenText = (d: Decision) => d.choose.map((c) => (typeof c === "number" ? d.options?.[c - 1] : d.options?.[d.optionIds?.indexOf(String(c)) ?? -1]) ?? String(c)).join(", ") || "(pass)";

export const pct = (x: number) => `${Math.round(x * 100)}%`;
export const secs = (ms: number) => ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`;
