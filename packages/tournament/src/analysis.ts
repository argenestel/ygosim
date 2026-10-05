import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local structural types keep this analysis layer independent of runner modules.
export interface Tournament {
  id: string;
  name: string;
  scored?: boolean;
  players: { id: string; label: string }[];
  games: Game[];
}
export interface Game {
  id: string;
  status: string;
  seats: [string, string];
  winner: string | null;
  stage?: string;
  turns?: number;
  decks?: Record<string, { name: string; source: 'sample' | 'custom'; reason?: string; main: number[]; extra: number[] }>;
  stats?: Record<string, { decisions?: number; avgDecisionMs?: number; timedDecisions?: number; latencyKind?: 'response'; invalid?: number; toolCalls?: number; resumes?: number; reasonsGiven?: number }>;
}
export interface Decision {
  t?: number; turn?: number; phase?: string; promptId?: string; promptKind?: string;
  options?: string[]; optionIds?: string[]; choose?: (string | number)[]; selected?: string[]; reason?: string;
  ms?: number; toolMs?: number; latencyKind?: 'response';
}
export interface ToolCall { t?: number; tool?: string; ok?: boolean; ms?: number }
export interface RecordStats { played: number; wins: number; losses: number; draws: number; win_rate: number }
export interface Rating { estimate: number; ci: [number, number] }
export interface AgentMetrics {
  id: string; label: string; elo: number; elo_ci: [number, number];
  record: RecordStats; win_rate: number; win_rate_ci: [number, number]; wins: number; losses: number; draws: number; played: number;
  seat_performance: { first: RecordStats; second: RecordStats };
  win_rate_as_first: number; win_rate_as_second: number;
  stages: Record<string, RecordStats>; avg_turns: number;
  decision_metrics: {
    avg_ms: number; median_ms: number; p90_ms: number; total_decisions: number; per_game: number;
    timed_decisions: number; quantile_samples: number; latency_source: 'response' | 'legacy_tool_wait' | 'mixed' | 'unavailable';
  };
  reason_stats: { avg_length: number; median_length: number; p90_length: number; given_rate: number };
  deck_picks: { sample: number; custom: number; diversity: number; avg_custom_size: number };
  invalid_rate: number; pass_rate: number;
  tool_stats: { total_calls: number; failures: number; resumes: number };
  decks: ({ name: string; picks: number; pick_count: number } & RecordStats)[];
}
export interface HeadToHeadRecord {
  agent_a: string; agent_b: string; record: { a_wins: number; b_wins: number; draws: number };
  win_rate: number; bradley_terry: Rating;
}
export interface DeckMetaRecord {
  name: string; source: 'sample' | 'custom'; picks: number; pick_count: number; wins: number;
  win_rate: number; ci: [number, number]; picked_by: Record<string, number>;
}
export const tournamentRoot = (): string => process.env.YGOSIM_TOURNAMENT_DIR || fileURLToPath(new URL('../../../data/tournaments/', import.meta.url));
export function validId(id: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id); }
function readLines<T>(tid: string, gid: string, pid: string, suffix: string): T[] {
  if (![tid, gid, pid].every(validId)) return [];
  try {
    return readFileSync(join(tournamentRoot(), tid, 'games', gid, `${pid}.${suffix}.jsonl`), 'utf8')
      .split(/\r?\n/).flatMap(line => {
        try { const value: unknown = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? [value as T] : []; }
        catch { return []; }
      });
  } catch { return []; }
}
export function readDecisions(tid: string, gid: string, pid: string): Decision[] { return readLines(tid, gid, pid, 'decisions'); }
export function readToolCalls(tid: string, gid: string, pid: string): ToolCall[] { return readLines(tid, gid, pid, 'tools'); }
const ratio = (a: number, b: number): number => b ? a / b : 0;
const count = (n: unknown): number => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
const average = (values: number[]): number => ratio(values.reduce((a, b) => a + b, 0), values.length);
function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * p, lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}
function emptyRecord(): RecordStats { return { played: 0, wins: 0, losses: 0, draws: 0, win_rate: 0 }; }
function addResult(record: RecordStats, game: Game, id: string): void {
  record.played++;
  if (game.winner === id) record.wins++;
  else if (game.winner == null) record.draws++;
  else record.losses++;
  record.win_rate = ratio(record.wins, record.played);
}
function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function isPass(decision: Decision): boolean {
  const options = decision.options;
  if (!Array.isArray(options)) return false;
  const choices = Array.isArray(decision.selected) ? decision.selected : decision.choose;
  if (!Array.isArray(choices)) return false;
  return choices.some(choice => {
    const index = typeof choice === 'number' && Number.isInteger(choice) && choice > 0 ? choice - 1
      : typeof choice === 'string' && Array.isArray(decision.optionIds) ? decision.optionIds.indexOf(choice) : -1;
    const option = options[index];
    return typeof option === 'string' && /\b(pass|cancel|do not|don't|do nothing|skip|no action|decline)\b/i.test(option);
  });
}
// Inverse standard normal CDF, using a monotone binary search on the normal CDF.
function normalQuantile(p: number): number {
  const cdf = (x: number) => {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - tail : tail;
  };
  let lo = -10, hi = 10;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (cdf(mid) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
export class BenchmarkAnalyzer {
  readonly tournaments: Tournament[];
  readonly completedGames: { tournament: Tournament; game: Game }[];
  private metrics?: AgentMetrics[];
  private ratings?: Map<string, Rating>;
  constructor(tournaments: Tournament[], options: { includeUnscored?: boolean; includeLegacy?: boolean } = {}) {
    this.tournaments = tournaments.filter(t => (options.includeUnscored || t.scored !== false) && (options.includeLegacy !== false || t.scored === true || options.includeUnscored && t.scored === false));
    this.completedGames = this.tournaments.flatMap(tournament => tournament.games.filter(game => game.status === 'done' && Array.isArray(game.seats) && game.seats.length === 2).map(game => ({ tournament, game })));
  }
  computeWilsonCI(wins: number, plays: number, confidence = 0.95): [number, number] {
    if (!(confidence > 0 && confidence < 1)) throw new RangeError('Confidence must be between 0 and 1');
    if (plays <= 0) return [0, 1];
    const p = Math.min(1, Math.max(0, wins / plays)), z = normalQuantile((1 + confidence) / 2), z2 = z * z;
    const center = (p + z2 / (2 * plays)) / (1 + z2 / plays);
    const half = z * Math.sqrt(p * (1 - p) / plays + z2 / (4 * plays * plays)) / (1 + z2 / plays);
    return [Math.max(0, center - half), Math.min(1, center + half)];
  }
  computeBradleyTerry(agentA: string, agentB: string, seed = 42, iterations = 1000): Rating {
    const scores = this.completedGames.filter(({ game }) => game.seats.includes(agentA) && game.seats.includes(agentB) && agentA !== agentB)
      .map(({ game }) => game.winner == null ? 0.5 : game.winner === agentA ? 1 : 0);
    if (!scores.length) return { estimate: 1500, ci: [1500, 1500] };
    // Half-win smoothing avoids infinite ratings; pair ratings have a 1500 midpoint.
    const rating = (wins: number) => 1500 + 200 * Math.log10((wins + 0.5) / (scores.length - wins + 0.5));
    const estimate = rating(scores.reduce<number>((a, b) => a + b, 0)), random = randomGenerator(seed), samples: number[] = [];
    for (let i = 0; i < Math.max(1, iterations); i++) {
      let wins = 0; for (let j = 0; j < scores.length; j++) wins += scores[Math.floor(random() * scores.length)];
      samples.push(rating(wins));
    }
    return { estimate, ci: [percentile(samples, 0.025), percentile(samples, 0.975)] };
  }
  /** Joint Bradley–Terry fit, with a half-win/half-loss prior versus a fixed baseline. */
  strengthRatings(): Map<string, Rating> {
    if (this.ratings) return this.ratings;
    const ids = [...new Set([...this.tournaments.flatMap(t => t.players.map(p => p.id)), ...this.completedGames.flatMap(({ game }) => game.seats)])].sort();
    const indices = new Map(ids.map((id, i) => [id, i]));
    const matches = this.completedGames.map(({ game }) => [indices.get(game.seats[0])!, indices.get(game.seats[1])!, game.winner == null ? 0.5 : game.winner === game.seats[0] ? 1 : 0]);
    const fit = (rows: number[][]): number[] => {
      const s = ids.map(() => 0);
      for (let iteration = 0; iteration < 100; iteration++) {
        const gradient = s.map(v => 0.5 - 1 / (1 + Math.exp(-v)));
        const hessian = s.map(v => { const p = 1 / (1 + Math.exp(-v)); return p * (1 - p); });
        for (const [a, b, score] of rows) {
          const p = 1 / (1 + Math.exp(s[b] - s[a])), curvature = p * (1 - p);
          gradient[a] += score - p; gradient[b] -= score - p; hessian[a] += curvature; hessian[b] += curvature;
        }
        let delta = 0;
        s.forEach((_, i) => { const step = 0.5 * gradient[i] / Math.max(hessian[i], 1e-8); s[i] += step; delta = Math.max(delta, Math.abs(step)); });
        if (delta < 1e-7) break;
      }
      const center = average(s);
      return s.map(v => 1500 + 400 / Math.LN10 * (v - center));
    };
    const estimates = fit(matches), samples = ids.map(() => [] as number[]), random = randomGenerator(42);
    if (matches.length) for (let iteration = 0; iteration < 1000; iteration++) {
      const result = fit(matches.map(() => matches[Math.floor(random() * matches.length)]));
      result.forEach((v, i) => samples[i].push(v));
    }
    this.ratings = new Map(ids.map((id, i) => [id, { estimate: estimates[i], ci: samples[i].length ? [percentile(samples[i], 0.025), percentile(samples[i], 0.975)] : [1500, 1500] }]));
    return this.ratings;
  }
  agentMetrics(agentId?: string): AgentMetrics[] {
    if (!this.metrics) {
      this.metrics = [...this.strengthRatings()].map(([id, rating]) => {
        const record = emptyRecord(), first = emptyRecord(), second = emptyRecord(), stages: Record<string, RecordStats> = {};
        const decks = new Map<string, { name: string; picks: number; pick_count: number } & RecordStats>();
        const latency: number[] = [], lengths: number[] = [], turns: number[] = [], customSizes: number[] = [];
        let decisions = 0, reasons = 0, invalid = 0, calls = 0, resumes = 0, failures = 0, passes = 0, loggedDecisions = 0, sample = 0, custom = 0;
        let latencySum = 0, responseTimings = 0, legacyTimings = 0;
        for (const { tournament, game } of this.completedGames.filter(({ game }) => game.seats.includes(id))) {
          addResult(record, game, id); addResult(game.seats[0] === id ? first : second, game, id);
          const stage = game.stage || 'round-robin'; addResult(stages[stage] ||= emptyRecord(), game, id);
          if (typeof game.turns === 'number' && Number.isFinite(game.turns)) turns.push(game.turns);
          const stats = game.stats?.[id], logs = readDecisions(tournament.id, game.id, id), tools = readToolCalls(tournament.id, game.id, id);
          const total = stats?.decisions == null ? logs.length : count(stats.decisions);
          decisions += total; reasons += stats?.reasonsGiven == null ? logs.filter(d => typeof d.reason === 'string' && d.reason.length > 0).length : count(stats.reasonsGiven);
          invalid += count(stats?.invalid); calls += stats?.toolCalls == null ? tools.length : count(stats.toolCalls); resumes += count(stats?.resumes);
          failures += tools.filter(t => t.ok === false).length;
          let loggedTimes = 0;
          for (const d of logs) {
            if (typeof d.ms !== 'number' || !Number.isFinite(d.ms) || d.ms < 0) continue;
            latency.push(d.ms); latencySum += d.ms; loggedTimes++;
            if (d.latencyKind === 'response') responseTimings++;
            else legacyTimings++;
          }
          if (!loggedTimes && typeof stats?.avgDecisionMs === 'number' && Number.isFinite(stats.avgDecisionMs) && stats.avgDecisionMs >= 0) {
            const response = stats.latencyKind === 'response', weight = response ? count(stats.timedDecisions) : total;
            latencySum += stats.avgDecisionMs * weight;
            if (response) responseTimings += weight;
            else legacyTimings += weight;
          }
          lengths.push(...logs.flatMap(d => typeof d.reason === 'string' ? [d.reason.length] : []));
          passes += logs.filter(isPass).length; loggedDecisions += logs.length;
          const deck = game.decks?.[id];
          if (deck) {
            let entry = decks.get(deck.name); if (!entry) { entry = { name: deck.name, picks: 0, pick_count: 0, ...emptyRecord() }; decks.set(deck.name, entry); }
            entry.picks++; entry.pick_count++; addResult(entry, game, id);
            if (deck.source === 'sample') sample++;
            else { custom++; customSizes.push((deck.main?.length || 0) + (deck.extra?.length || 0)); }
          }
        }
        const timedDecisions = responseTimings + legacyTimings;
        const latencySource: AgentMetrics['decision_metrics']['latency_source'] = responseTimings && legacyTimings ? 'mixed' : responseTimings ? 'response' : legacyTimings ? 'legacy_tool_wait' : 'unavailable';
        return { id, label: this.tournaments.flatMap(t => t.players).find(p => p.id === id)?.label || id,
          elo: rating.estimate, elo_ci: rating.ci, record, ...record, win_rate_ci: this.computeWilsonCI(record.wins, record.played), seat_performance: { first, second }, win_rate_as_first: first.win_rate, win_rate_as_second: second.win_rate,
          stages, avg_turns: average(turns), decision_metrics: { avg_ms: ratio(latencySum, timedDecisions), median_ms: percentile(latency, 0.5), p90_ms: percentile(latency, 0.9), total_decisions: decisions, per_game: ratio(decisions, record.played), timed_decisions: timedDecisions, quantile_samples: latency.length, latency_source: latencySource },
          reason_stats: { avg_length: average(lengths), median_length: percentile(lengths, 0.5), p90_length: percentile(lengths, 0.9), given_rate: ratio(reasons, decisions) },
          deck_picks: { sample, custom, diversity: ratio(decks.size, record.played), avg_custom_size: average(customSizes) },
          invalid_rate: ratio(invalid, decisions), pass_rate: ratio(passes, loggedDecisions), tool_stats: { total_calls: calls, failures, resumes }, decks: [...decks.values()].sort((a, b) => a.name.localeCompare(b.name)) };
      });
    }
    return this.metrics.filter(a => !agentId || a.id === agentId);
  }
  headToHeadMatrix(): HeadToHeadRecord[] {
    const ids = this.agentMetrics().map(a => a.id), rows: HeadToHeadRecord[] = [];
    for (const a of ids) for (const b of ids) {
      if (a === b) continue;
      const matches = this.completedGames.filter(({ game }) => game.seats.includes(a) && game.seats.includes(b));
      if (!matches.length) continue;
      const a_wins = matches.filter(({ game }) => game.winner === a).length, b_wins = matches.filter(({ game }) => game.winner === b).length, draws = matches.filter(({ game }) => game.winner == null).length;
      rows.push({ agent_a: a, agent_b: b, record: { a_wins, b_wins, draws }, win_rate: ratio(a_wins, matches.length), bradley_terry: this.computeBradleyTerry(a, b) });
    }
    return rows;
  }
  deckMeta(): DeckMetaRecord[] {
    const decks = new Map<string, DeckMetaRecord>();
    for (const { game } of this.completedGames) for (const id of game.seats) {
      const deck = game.decks?.[id]; if (!deck) continue;
      // Source is part of identity so a custom deck named after a sample remains distinct.
      const key = JSON.stringify([deck.name, deck.source]);
      let entry = decks.get(key); if (!entry) { entry = { name: deck.name, source: deck.source, picks: 0, pick_count: 0, wins: 0, win_rate: 0, ci: [0, 1], picked_by: {} }; decks.set(key, entry); }
      entry.picks++; entry.pick_count++; entry.wins += Number(game.winner === id); entry.picked_by[id] = (entry.picked_by[id] || 0) + 1;
    }
    return [...decks.values()].map(d => ({ ...d, win_rate: ratio(d.wins, d.picks), ci: this.computeWilsonCI(d.wins, d.picks) })).sort((a, b) => b.picks - a.picks || a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  }
}
