// Client for the tournament API described in docs/TOURNAMENT.md.
import type { Frame } from "./replay";

export type Provider = "xai" | "openai" | "anthropic" | "google" | "deepseek" | "zai" | "unknown";
export interface TPlayer { id: string; label: string; cli: "codex" | "pi" | "claude" | "agy"; model: string; effort?: string; codeMode?: boolean; provider?: Provider; host?: "Fireworks" }
/** "scored" counts toward the leaderboard; "validation" proves a roster can play; "legacy" predates the distinction. */
export type TKind = "scored" | "validation" | "legacy";
export type TState = "live" | "paused" | "finished";
export interface Progress { done: number; total: number; live: number; errors: number }
export interface Leader { id: string; label: string; points: number; wins: number; losses: number; draws: number }
export interface TDeck { name: string; title?: string; source: "sample" | "custom"; reason: string; main: number[]; extra: number[]; side?: number[]; fingerprint?: string }
export interface TStats { decisions: number; avgDecisionMs: number; invalid: number; toolCalls: number; resumes: number; reasonsGiven: number }
export interface TGame {
  id: string; stage: "round-robin" | "final" | "series"; round: number; seats: [string, string];
  status: "pending" | "running" | "done" | "error";
  winner: string | null; reason?: string; startedAt?: string; endedAt?: string; turns?: number;
  decks: Record<string, TDeck>; stats: Record<string, TStats>; error?: string; seed?: number; cycle?: number; attempt?: number;
  /** Final life points per seat, when the runner recorded them. */
  lp?: Record<string, number>;
  durationMs?: number;
  /** Board snapshot of a running game, derived server-side from the last replay frame. */
  live?: { turn: number; phase: string; turnPlayer: number; lp: [number, number]; at: string };
}
export interface Standing {
  id: string; label: string; model: string; elo: number; played: number; wins: number; losses: number; draws: number;
  points: number; winRate: number; avgTurns: number; avgDecisionMs: number; invalidRate: number; reasonRate: number;
  crashes: number; decks: { name: string; played: number; wins: number }[];
}
export interface DeckStat { name: string; source: "sample" | "custom"; picks: number; wins: number; pickedBy: Record<string, number> }
export interface TSummary {
  id: string; name: string; createdAt: string; status: "running" | "done"; players: TPlayer[]; done: number; total: number; paused?: boolean; active?: boolean;
  kind?: TKind; state?: TState; format?: string; progress?: Progress; leader?: Leader | null; champion?: string | null; scored?: boolean;
}
export interface Tournament {
  id: string; name: string; createdAt: string; status: "running" | "done"; format: string; players: TPlayer[]; games: TGame[]; standings: Standing[];
  /** A runner currently owns this tournament (derived from its lock). Missing on older servers. */
  active?: boolean; paused?: boolean; pausedAt?: string;
  kind?: TKind; state?: TState; progress?: Progress; champion?: string | null;
  /** Explicit provenance from the runner. Undefined means legacy data with no scoring claim. */
  scored?: boolean;
  deckPolicy?: "choice" | "custom-only";
  validation?: { passed: boolean; checkedPlayers: string[]; missingPlayers: string[] };
  audit?: { validatedBy?: string; revision?: string; sourceHash?: string; server?: string; seed?: number; maxMinutes?: number; onTimeout?: "lp" | "draw" };
  series?: { bestOf: 3; seed?: number; wins: Record<string, number>; winner: string | null; complete: boolean }
}
export interface Leaderboard { players: (Standing & { provider?: Provider; host?: "Fireworks" })[]; decks: DeckStat[]; updatedAt: string }
/** One match with everything a match page needs: GET /api/tournaments/:tid/games/:gid. */
export interface GameView {
  tournament: { id: string; name: string; kind: TKind; state: TState; format: string; maxMinutes?: number; onTimeout?: "lp" | "draw" };
  players: [TPlayer, TPlayer];
  game: TGame;
}
/** Both seats merged into one ordered stream: GET …/games/:gid/timeline. `at` is ms since the game started. */
export type TimelineEvent =
  | { type: "deck"; at: number; seat: 0 | 1; player: string; title: string; size: { main: number; extra: number; side: number }; reason: string }
  | { type: "decision"; at: number; seat: 0 | 1; player: string; turn?: number; phase?: string; prompt: { kind: string; label: string }; choice: string[]; reason?: string; thinkMs?: number }
  | { type: "tool"; at: number; seat: 0 | 1; player: string; tool: string; ok: boolean; ms: number; summary: string }
  | { type: "result"; at: number; winner: string | null; reason: string; lp?: Record<string, number>; turns?: number };
export interface Timeline { events: TimelineEvent[]; cursor: string; final: boolean }
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
export const getGame = (tid: string, gid: string) => get<GameView>(gamePath(tid, gid));
export const getTimeline = (tid: string, gid: string, cursor: string, tools = false) =>
  get<Timeline>(`${gamePath(tid, gid)}/timeline?${new URLSearchParams({ ...(cursor ? { cursor } : {}), ...(tools ? { include: "tools" } : {}) })}`);
/** Organizer-only raw CLI output (transcript JSONL / stderr), last ~512 KB. */
export const getRawLog = async (tid: string, gid: string, pid: string, kind: "transcript" | "stderr") =>
  (await request(`${gamePath(tid, gid)}/${kind}/${enc(pid)}`)).text();



/** Human label for a game-end reason. */
export const REASONS: Record<string, string> = {
  lp: "life points", deck: "deck out", surrender: "surrender", timeout: "time · equal LP", "time-lp": "time · LP lead",
  "decision-timeout": "decision timeout", "invalid-actions": "illegal actions", "agent-crash": "agent crashed", "infrastructure-error": "infrastructure error",
};
export const reasonText = (r?: string) => (r ? REASONS[r] ?? r : "");

/** Running state as the viewer should read it: live (runner attached), paused (no runner), or done. */
export const liveness = (t: { status: "running" | "done"; active?: boolean; paused?: boolean }): "live" | "paused" | "done" =>
  t.status !== "running" ? "done" : t.active === false || t.paused ? "paused" : "live";

/** Server-provided kind, or the same rule applied to an older server's fields. */
export const kindOf = (t: { kind?: TKind; scored?: boolean; name?: string }): TKind =>
  t.kind ?? (t.scored === true ? "scored" : t.scored === false || /\(unscored validation\)\s*$/.test(t.name ?? "") ? "validation" : "legacy");
export const stateOf = (t: { state?: TState; status: "running" | "done"; active?: boolean; paused?: boolean }): TState =>
  t.state ?? ({ done: "finished", live: "live", paused: "paused" } as const)[liveness(t)];
/** Older servers glue the kind into the name. */
export const cleanName = (name: string) => name.replace(/\s*\((?:unscored )?validation\)\s*$/i, "");
export const FORMATS: Record<string, string> = { "round-robin+final": "Round robin + final", "best-of-three": "Best of three" };
export const formatText = (f?: string) => (f ? FORMATS[f] ?? f.replace(/[-+]/g, " ") : "");
export const PHASES: Record<string, string> = { draw: "Draw", standby: "Standby", main1: "Main 1", battle: "Battle", main2: "Main 2", end: "End" };
export const phaseText = (p?: string) => (p ? PHASES[p] ?? p : "");

/** Deck display name: the agent's own title, else the first clause of its explanation, else the stored name. */
export function deckTitle(d: TDeck): string {
  if (d.title) return d.title;
  if (!/^Custom deck [0-9a-f]+$/.test(d.name) || !d.reason) return d.name;
  const clause = d.reason.split(/\. |:|;| — |\n/)[0]!.trim();
  return clause.length <= 48 ? clause : `${clause.slice(0, 48).replace(/\s+\S*$/, "")}…`;
}
/** The deck's most-played main card: its art stands in for the deck. */
export function signatureCard(d?: Pick<TDeck, "main" | "extra">): number | undefined {
  if (!d) return undefined;
  const counts = new Map<number, number>();
  for (const c of d.main) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best: number | undefined, n = 0;
  for (const [c, k] of counts) if (k > n) { best = c; n = k; }
  return best ?? d.extra[0];
}
export function ago(iso?: string, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
export const duration = (ms?: number) => (!ms ? "" : ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m` : ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`);

export const pct = (x: number) => `${Math.round(x * 100)}%`;
export const secs = (ms: number) => ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`;
