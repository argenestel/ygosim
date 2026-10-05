import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchmarkAnalyzer, readDecisions, readToolCalls } from '../src/analysis.js';
import type { Game, Tournament } from '../src/analysis.js';
import { generateReport, parseReportArgs } from '../src/report-cli.js';
import type { ReportOptions } from '../src/report-cli.js';

// Importable fixtures stay local to this new test module.
export function fixtureTournament(): Tournament {
  return { id: 'fixture', name: 'Fixture tournament', scored: true, players: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }], games: [{
    id: 'game1', seats: ['a', 'b'], status: 'done', winner: 'a', stage: 'round-robin', turns: 8,
    decks: { a: { name: 'Sample', source: 'sample', main: [1, 2], extra: [] }, b: { name: 'Custom', source: 'custom', main: [3, 4], extra: [5] } },
    stats: { a: { decisions: 3, avgDecisionMs: 999, reasonsGiven: 2, invalid: 1, toolCalls: 4, resumes: 1 }, b: { decisions: 2, avgDecisionMs: 500, reasonsGiven: 1, invalid: 0, toolCalls: 0, resumes: 0 } },
  }] };
}
let root: string;
function log(pid: string, suffix: string, entries: unknown[]): void {
  const dir = join(root, 'fixture', 'games', 'game1'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pid}.${suffix}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}
function store(tournament: Tournament): void {
  const dir = join(root, tournament.id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tournament.json'), JSON.stringify(tournament));
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ygo-analysis-'));
  vi.stubEnv('YGOSIM_TOURNAMENT_DIR', root);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('benchmark metrics', () => {
  it('computes wins, seats, decision quantiles, reasons, passes, and tool failures', () => {
    log('a', 'decisions', [
      { ms: 100, reason: 'abcd', options: ['Do not activate / pass', 'Activate'], choose: [1] },
      { ms: 200, reason: '  abcdef  ', options: ['Cancel', 'Select'], optionIds: ['cancel:effect', 'select:card'], choose: ['cancel:effect'] },
      { ms: 900, reason: '', options: ['Attack', 'Pass'], choose: [1] },
    ]);
    log('a', 'tools', [{ ok: true }, { ok: false }, { ok: false }]);
    const analyzer = new BenchmarkAnalyzer([fixtureTournament()]);
    const [a] = analyzer.agentMetrics('a'), [b] = analyzer.agentMetrics('b');
    expect(a.record).toEqual({ played: 1, wins: 1, losses: 0, draws: 0, win_rate: 1 });
    expect(a.win_rate).toBe(1); expect(b.win_rate).toBe(0);
    expect(a.seat_performance.first.wins).toBe(1); expect(b.seat_performance.second.losses).toBe(1);
    expect(a.win_rate_as_first).toBe(1); expect(a.win_rate_as_second).toBe(0);
    expect(a.decision_metrics.avg_ms).toBe(400);
    expect(a.decision_metrics.median_ms).toBe(200); expect(a.decision_metrics.p90_ms).toBeCloseTo(760);
    expect(a.decision_metrics.total_decisions).toBe(3); expect(a.decision_metrics.per_game).toBe(3);
    expect(a.decision_metrics.latency_source).toBe('legacy_tool_wait');
    expect(a.decision_metrics.timed_decisions).toBe(3); expect(a.decision_metrics.quantile_samples).toBe(3);
    expect(a.reason_stats.avg_length).toBeCloseTo(14 / 3); expect(a.reason_stats.median_length).toBe(4);
    expect(a.reason_stats.p90_length).toBeCloseTo(8.8); expect(a.reason_stats.given_rate).toBeCloseTo(2 / 3);
    expect(a.invalid_rate).toBeCloseTo(1 / 3); expect(a.pass_rate).toBeCloseTo(2 / 3);
    expect(a.tool_stats).toEqual({ total_calls: 4, failures: 2, resumes: 1 });
    expect(b.deck_picks).toEqual({ sample: 0, custom: 1, diversity: 1, avg_custom_size: 3 });
    expect(a.avg_turns).toBe(8); expect(a.stages['round-robin'].played).toBe(1);
    expect(analyzer.agentMetrics('unknown')).toEqual([]);
  });
  it('uses weighted stored latency when decision logs are absent or empty', () => {
    log('a', 'decisions', []);
    const tournament = fixtureTournament();
    tournament.games.push({ ...tournament.games[0], id: 'game2', seats: ['b', 'a'], winner: null, stage: 'final', stats: { a: { decisions: 1, avgDecisionMs: 100 } } });
    const [a] = new BenchmarkAnalyzer([tournament]).agentMetrics('a');
    expect(a.decision_metrics.avg_ms).toBeCloseTo((999 * 3 + 100) / 4);
    expect(a.decision_metrics.total_decisions).toBe(4); expect(a.decision_metrics.per_game).toBe(2);
    expect(a.decision_metrics.latency_source).toBe('legacy_tool_wait'); expect(a.decision_metrics.timed_decisions).toBe(4);
    expect(a.decision_metrics.quantile_samples).toBe(0);
    expect(a.seat_performance.second.draws).toBe(1); expect(a.stages.final.draws).toBe(1);
    expect(a.reason_stats.avg_length).toBe(0); expect(a.pass_rate).toBe(0);
    expect(a.tool_stats.failures).toBe(0);
  });
  it('detects 1-based pass choices at any option index', () => {
    log('a', 'decisions', [
      { options: ['Pass', 'Activate'], choose: [1] },
      { options: ['Attack', 'Skip'], choose: [2] },
      { options: ['Summon', 'Activate', 'Do nothing'], choose: [3] },
      { options: ['Cancel', 'Activate'], choose: [2] },
    ]);
    expect(new BenchmarkAnalyzer([fixtureTournament()]).agentMetrics('a')[0].pass_rate).toBe(3 / 4);
  });
  it('maps exact string IDs and resolved selections without guessing from ID text', () => {
    log('a', 'decisions', [
      { options: ['Attack', 'Cancel'], optionIds: ['attack:card', 'action:17'], choose: ['action:17'] },
      { options: ['Attack', 'Pass'], optionIds: ['pass:trap', 'end:battle'], choose: ['pass:trap'] },
      { options: ['Attack', 'Do nothing'], optionIds: ['atk:17', 'decline:53'], selected: ['decline:53'] },
      { options: ['Pass', 'Attack'], optionIds: ['response:no', 'response:yes'], choose: [1], selected: ['response:yes'] },
      { options: ['Activate', 'Pass'], optionIds: ['response:yes', 'response:no'], choose: [2], selected: ['response:no'] },
    ]);
    expect(new BenchmarkAnalyzer([fixtureTournament()]).agentMetrics('a')[0].pass_rate).toBe(3 / 5);
  });
  it('does not count zero or other invalid selections as passes', () => {
    log('a', 'decisions', [
      { options: ['Pass', 'Activate'], choose: [0] },
      { options: ['Pass', 'Activate'], choose: ['0'] },
      { options: ['Pass', 'Activate'], choose: [-1] },
      { options: ['Pass', 'Activate'], choose: [1.5] },
      { options: ['Pass', 'Activate'], choose: [3] },
      { options: ['Pass', 'Activate'], optionIds: ['response:no', 'response:yes'], choose: ['pass'] },
    ]);
    expect(new BenchmarkAnalyzer([fixtureTournament()]).agentMetrics('a')[0].pass_rate).toBe(0);
  });
  it('uses response latency independently of tool duration and excludes missing or invalid timing', () => {
    const tournament = fixtureTournament();
    tournament.games[0].stats = { a: { decisions: 6, avgDecisionMs: 100, timedDecisions: 3, latencyKind: 'response' } };
    log('a', 'decisions', [
      { ms: 100, toolMs: 9000, latencyKind: 'response' },
      { toolMs: 8000, latencyKind: 'response' },
      { ms: 0, toolMs: 7000, latencyKind: 'response' },
      { ms: 200, toolMs: 6000, latencyKind: 'response' },
      { ms: -1, toolMs: 5000, latencyKind: 'response' },
      { ms: '300', toolMs: 4000, latencyKind: 'response' },
    ]);
    const [a] = new BenchmarkAnalyzer([tournament]).agentMetrics('a');
    expect(a.decision_metrics.avg_ms).toBe(100); expect(a.decision_metrics.median_ms).toBe(100);
    expect(a.decision_metrics.p90_ms).toBe(180); expect(a.decision_metrics.total_decisions).toBe(6);
    expect(a.decision_metrics.timed_decisions).toBe(3); expect(a.decision_metrics.quantile_samples).toBe(3);
    expect(a.decision_metrics.latency_source).toBe('response');
  });
  it('weights response fallback by timed decisions rather than all submitted actions', () => {
    const tournament = fixtureTournament(), original = tournament.games[0];
    tournament.games = [
      { ...original, stats: { a: { decisions: 100, avgDecisionMs: 100, timedDecisions: 2, latencyKind: 'response' } } },
      { ...original, id: 'game2', stats: { a: { decisions: 900, avgDecisionMs: 400, timedDecisions: 1, latencyKind: 'response' } } },
      { ...original, id: 'game3', stats: { a: { decisions: 500, avgDecisionMs: 0, timedDecisions: 0, latencyKind: 'response' } } },
    ];
    const [a] = new BenchmarkAnalyzer([tournament]).agentMetrics('a');
    expect(a.decision_metrics.avg_ms).toBe(200); expect(a.decision_metrics.total_decisions).toBe(1500);
    expect(a.decision_metrics.timed_decisions).toBe(3); expect(a.decision_metrics.quantile_samples).toBe(0);
    expect(a.decision_metrics.latency_source).toBe('response');
  });
  it('does not manufacture zero-latency samples when timing or its sample count is missing', () => {
    const tournament = fixtureTournament(), original = tournament.games[0];
    tournament.games = [
      { ...original, stats: { a: { decisions: 2, avgDecisionMs: 0, timedDecisions: 0, latencyKind: 'response' } } },
      { ...original, id: 'game2', stats: { a: { decisions: 3, avgDecisionMs: 100, latencyKind: 'response' } } },
      { ...original, id: 'game3', stats: { a: { decisions: 4 } } },
    ];
    log('a', 'decisions', [{ toolMs: 5000, latencyKind: 'response' }, { latencyKind: 'response' }]);
    const [a] = new BenchmarkAnalyzer([tournament]).agentMetrics('a');
    expect(a.decision_metrics.avg_ms).toBe(0); expect(a.decision_metrics.timed_decisions).toBe(0);
    expect(a.decision_metrics.quantile_samples).toBe(0); expect(a.decision_metrics.latency_source).toBe('unavailable');
    expect(a.decision_metrics.total_decisions).toBe(9);
  });
  it('marks mixed response and legacy timing without relabeling unmarked log rows', () => {
    const tournament = fixtureTournament();
    tournament.games[0].stats = { a: { decisions: 2, avgDecisionMs: 300, timedDecisions: 1, latencyKind: 'response' } };
    log('a', 'decisions', [{ ms: 100 }, { ms: 300, toolMs: 5000, latencyKind: 'response' }]);
    const [a] = new BenchmarkAnalyzer([tournament]).agentMetrics('a');
    expect(a.decision_metrics.avg_ms).toBe(200); expect(a.decision_metrics.timed_decisions).toBe(2);
    expect(a.decision_metrics.latency_source).toBe('mixed');
  });
  it('combines logged timings with weighted stored averages without inventing quantile samples', () => {
    const tournament = fixtureTournament();
    tournament.games.push({ ...tournament.games[0], id: 'game2', stats: { a: { decisions: 20, avgDecisionMs: 400, timedDecisions: 2, latencyKind: 'response' } } });
    log('a', 'decisions', [{ ms: 100, toolMs: 9000, latencyKind: 'response' }]);
    const [a] = new BenchmarkAnalyzer([tournament]).agentMetrics('a');
    expect(a.decision_metrics.avg_ms).toBe(300); expect(a.decision_metrics.timed_decisions).toBe(3);
    expect(a.decision_metrics.median_ms).toBe(100); expect(a.decision_metrics.p90_ms).toBe(100);
    expect(a.decision_metrics.quantile_samples).toBe(1); expect(a.decision_metrics.latency_source).toBe('response');
  });
  it.each([undefined, 'response'] as const)('handles large stored decision counts without expanding timing arrays (%s)', latencyKind => {
    const tournament = fixtureTournament();
    tournament.games[0].stats = { a: { decisions: 1_000_000_000, avgDecisionMs: 123, ...(latencyKind ? { latencyKind, timedDecisions: 7 } : {}) } };
    const [a] = new BenchmarkAnalyzer([tournament]).agentMetrics('a');
    expect(a.decision_metrics.avg_ms).toBe(123); expect(a.decision_metrics.total_decisions).toBe(1_000_000_000);
    expect(a.decision_metrics.timed_decisions).toBe(latencyKind ? 7 : 1_000_000_000);
    expect(a.decision_metrics.quantile_samples).toBe(0); expect(a.decision_metrics.median_ms).toBe(0);
    expect(a.decision_metrics.latency_source).toBe(latencyKind ? 'response' : 'legacy_tool_wait');
  });
  it('ignores partial games and tolerates missing stats and decks', () => {
    const tournament = fixtureTournament();
    tournament.games.push({ ...tournament.games[0], id: 'pending', status: 'running', winner: 'b' });
    delete tournament.games[0].stats; delete tournament.games[0].decks;
    const [a] = new BenchmarkAnalyzer([tournament]).agentMetrics('a');
    expect(a.played).toBe(1); expect(a.decision_metrics.total_decisions).toBe(0);
    expect(a.decks).toEqual([]); expect(a.invalid_rate).toBe(0); expect(a.deck_picks.diversity).toBe(0);
  });
  it('aggregates the same player across tournaments, seats, and stages', () => {
    const first = fixtureTournament(), second = fixtureTournament(); second.id = 'other';
    second.games[0] = { ...second.games[0], seats: ['b', 'a'], winner: 'b', stage: 'final' };
    const [a] = new BenchmarkAnalyzer([first, second]).agentMetrics('a');
    expect(a.played).toBe(2); expect(a.win_rate).toBe(0.5);
    expect(a.seat_performance.first.wins).toBe(1); expect(a.seat_performance.second.losses).toBe(1);
    expect(a.deck_picks.diversity).toBe(0.5); expect(a.decks[0].picks).toBe(2);
  });
  it('excludes unscored tournaments from all global benchmark metrics by default', () => {
    const official = fixtureTournament(), validation = fixtureTournament();
    validation.id = 'validation'; validation.scored = false;
    validation.players.push({ id: 'unscored-only', label: 'Unscored agent' });
    validation.games[0].winner = 'b';
    const analyzer = new BenchmarkAnalyzer([official, validation]), baseline = new BenchmarkAnalyzer([official]);
    expect(analyzer.tournaments.map(t => t.id)).toEqual(['fixture']); expect(analyzer.completedGames).toHaveLength(1);
    expect(analyzer.agentMetrics()).toEqual(baseline.agentMetrics()); expect(analyzer.agentMetrics('unscored-only')).toEqual([]);
    expect(analyzer.headToHeadMatrix()).toEqual(baseline.headToHeadMatrix()); expect(analyzer.deckMeta()).toEqual(baseline.deckMeta());
    expect(analyzer.computeBradleyTerry('a', 'b')).toEqual(baseline.computeBradleyTerry('a', 'b'));
    const included = new BenchmarkAnalyzer([official, validation], { includeUnscored: true });
    expect(included.completedGames).toHaveLength(2); expect(included.agentMetrics('a')[0].win_rate).toBe(0.5);
  });
});

describe('head-to-head and deck statistics', () => {
  it('has symmetric ordered records and mirrored ratings', () => {
    const analyzer = new BenchmarkAnalyzer([fixtureTournament()]);
    const [ab, ba] = analyzer.headToHeadMatrix();
    expect(ab.record).toEqual({ a_wins: 1, b_wins: 0, draws: 0 });
    expect(ba.record).toEqual({ a_wins: 0, b_wins: 1, draws: 0 });
    expect(ab.bradley_terry.estimate + ba.bradley_terry.estimate).toBeCloseTo(3000);
    expect(ab.bradley_terry.ci[0] + ba.bradley_terry.ci[1]).toBeCloseTo(3000);
    expect(ab.win_rate).toBe(1); expect(ba.win_rate).toBe(0);
  });
  it('computes deterministic Bradley–Terry strengths near smoothed odds', () => {
    const tournament = fixtureTournament(), original = tournament.games[0];
    tournament.games = Array.from({ length: 100 }, (_, i): Game => ({ ...original, id: `g${i}`, winner: i < 75 ? 'a' : 'b' }));
    const analyzer = new BenchmarkAnalyzer([tournament]);
    const bt = analyzer.computeBradleyTerry('a', 'b');
    expect(bt).toEqual(analyzer.computeBradleyTerry('a', 'b', 42, 1000));
    expect(bt.estimate).toBeCloseTo(1500 + 200 * Math.log10(75.5 / 25.5));
    expect(bt.estimate).toBeCloseTo(1595, -1);
    expect(bt.ci[0]).toBeLessThan(bt.estimate); expect(bt.ci[1]).toBeGreaterThan(bt.estimate);
    const [a, b] = analyzer.agentMetrics();
    expect(a.elo).toBeGreaterThan(b.elo); expect((a.elo + b.elo) / 2).toBeCloseTo(1500);
    expect(a.elo_ci[0]).toBeLessThan(a.elo); expect(a.elo_ci[1]).toBeGreaterThan(a.elo);
    expect(a.win_rate_ci).toEqual(analyzer.computeWilsonCI(75, 100));
    expect(analyzer.computeBradleyTerry('a', 'unknown')).toEqual({ estimate: 1500, ci: [1500, 1500] });
  });
  it('counts draws as half wins for strengths', () => {
    const tournament = fixtureTournament(); tournament.games[0].winner = null;
    const analyzer = new BenchmarkAnalyzer([tournament]);
    expect(analyzer.computeBradleyTerry('a', 'b').estimate).toBe(1500);
    expect(analyzer.headToHeadMatrix()[0].record.draws).toBe(1);
    expect(analyzer.agentMetrics()[0].elo).toBe(1500);
  });
  it('computes deck picks, wins, source, and picker counts', () => {
    const decks = new BenchmarkAnalyzer([fixtureTournament()]).deckMeta();
    const sample = decks.find(d => d.source === 'sample')!;
    expect(sample.picks).toBe(1); expect(sample.pick_count).toBe(1); expect(sample.wins).toBe(1);
    expect(sample.win_rate).toBe(1); expect(sample.picked_by).toEqual({ a: 1 });
    expect(decks.find(d => d.source === 'custom')!.win_rate).toBe(0);
    expect(sample.ci[0]).toBeGreaterThan(0); expect(sample.ci[1]).toBeCloseTo(1);
  });
  it('computes Wilson intervals including configurable confidence and extremes', () => {
    const analyzer = new BenchmarkAnalyzer([]), ci = analyzer.computeWilsonCI(5, 10);
    expect(ci[0]).toBeCloseTo(0.2366, 3); expect(ci[1]).toBeCloseTo(0.7634, 3);
    for (const [wins, plays] of [[0, 1], [1, 1], [3, 10], [99, 100]]) {
      const [lo, hi] = analyzer.computeWilsonCI(wins, plays);
      expect(lo).toBeGreaterThanOrEqual(0); expect(hi).toBeLessThanOrEqual(1);
      expect(lo).toBeLessThanOrEqual(wins / plays + 1e-10); expect(hi).toBeGreaterThanOrEqual(wins / plays - 1e-10);
    }
    expect(analyzer.computeWilsonCI(0, 0)).toEqual([0, 1]);
    expect(analyzer.computeWilsonCI(5, 10, 0.99)[0]).toBeLessThan(ci[0]);
    expect(() => analyzer.computeWilsonCI(5, 10, 1)).toThrow();
  });
});

describe('readers and report generation', () => {
  it('keeps unmarked legacy data out of global rankings and labels explicitly selected history', async () => {
    const t = fixtureTournament(); delete t.scored; store(t);
    const global = await generateReport({ outDir: join(root, 'official-only') });
    expect(JSON.parse(readFileSync(global.jsonPath, 'utf8')).agents).toEqual([]);
    const explicit = await generateReport({ tournamentIds: [t.id], outDir: join(root, 'history') });
    expect(JSON.parse(readFileSync(explicit.jsonPath, 'utf8')).meta.legacy_tournament_ids).toEqual([t.id]);
    expect(readFileSync(explicit.mdPath, 'utf8')).toContain('# Tournament Historical Report');
  });
  it('skips malformed lines and returns empty arrays for missing files', () => {
    expect(readDecisions('fixture', 'game1', 'a')).toEqual([]); expect(readToolCalls('fixture', 'game1', 'a')).toEqual([]);
    log('a', 'decisions', [{ ms: 50, reason: 'ok' }]);
    const path = join(root, 'fixture', 'games', 'game1', 'a.decisions.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8') + 'broken\nnull\n[]\n{"reason":"valid"}\n');
    expect(readDecisions('fixture', 'game1', 'a')).toHaveLength(2);
    expect(readDecisions('../fixture', 'game1', 'a')).toEqual([]);
  });
  it('writes all report sections and JSON, with deck-reason excerpts capped at 200 characters', async () => {
    const tournament = fixtureTournament(); store(tournament);
    log('a', 'decisions', [{ promptKind: 'deck-select', reason: 'x'.repeat(250), ms: 50 }]);
    const result = await generateReport({ outDir: join(root, 'output') });
    const markdown = readFileSync(result.mdPath, 'utf8'), json = JSON.parse(readFileSync(result.jsonPath, 'utf8'));
    for (const section of ['Leaderboard', 'Per-Agent Profile Cards', 'Head-to-Head', 'H2H Bradley-Terry Ratings', 'Deck Meta', 'Notable Games']) expect(markdown).toContain(`## ${section}`);
    expect(markdown).toContain('95% BT CI'); expect(markdown).toContain('95% Wilson CI');
    expect(markdown).toContain('20.7%–100.0%'); expect(markdown).toContain('Legacy tool-wait time');
    expect(markdown).toContain('not agent thinking time'); expect(markdown).toContain('Median/p90 use timed decision logs only');
    expect(markdown).toContain('Longest game:'); expect(markdown).toContain('Shortest game:');
    expect(markdown).toContain('x'.repeat(200)); expect(markdown).not.toContain('x'.repeat(201));
    expect(json.meta.tournament_ids).toEqual(['fixture']); expect(json.meta.game_count).toBe(1);
    expect(json.agents).toHaveLength(2); expect(json.head_to_head).toHaveLength(2); expect(json.deck_meta).toHaveLength(2);
    expect(Number.isNaN(Date.parse(json.meta.generated_at))).toBe(false);
    expect(json.agents.find((a: { id: string }) => a.id === 'a').decision_metrics.latency_source).toBe('legacy_tool_wait');
  });
  it('labels mixed timing and reports absent quantiles instead of fabricated stored-average percentiles', async () => {
    const tournament = fixtureTournament();
    tournament.games[0].stats = { a: { decisions: 2, avgDecisionMs: 300, timedDecisions: 1, latencyKind: 'response' }, b: { decisions: 10, avgDecisionMs: 200, timedDecisions: 2, latencyKind: 'response' } };
    log('a', 'decisions', [{ ms: 100 }, { ms: 300, toolMs: 9000, latencyKind: 'response' }]);
    const result = await generateReport({ tournaments: tournament, outDir: join(root, 'timing-report') });
    const markdown = readFileSync(result.mdPath, 'utf8'), json = JSON.parse(readFileSync(result.jsonPath, 'utf8'));
    expect(markdown).toContain('Mixed response / legacy tool-wait time'); expect(markdown).toContain('Response latency');
    expect(markdown).toContain('median/p90 unavailable'); expect(markdown).toContain('2 timed decisions; 0 logged timing samples');
    expect(markdown).toContain('weighted by timedDecisions'); expect(markdown).not.toContain('Decision quality:');
    expect(json.agents.find((a: { id: string }) => a.id === 'a').decision_metrics.latency_source).toBe('mixed');
    expect(json.agents.find((a: { id: string }) => a.id === 'b').decision_metrics.latency_source).toBe('response');
  });
  it('shows unavailable timing when no prompt response was timed', async () => {
    const tournament = fixtureTournament();
    tournament.games[0].stats = { a: { decisions: 2, avgDecisionMs: 0, timedDecisions: 0, latencyKind: 'response' } };
    log('a', 'decisions', [{ toolMs: 10000, latencyKind: 'response' }, { latencyKind: 'response' }]);
    const result = await generateReport({ tournaments: tournament, outDir: join(root, 'untimed-report') });
    const markdown = readFileSync(result.mdPath, 'utf8');
    expect(markdown).toContain('Timing unavailable'); expect(markdown).toContain('No recorded timing samples.');
    expect(markdown).not.toContain('average 0.0 ms');
  });
  it('keeps validation out of global reports while explicitly selected validation is visibly unscored', async () => {
    const official = fixtureTournament(), validation = fixtureTournament();
    validation.id = 'validation'; validation.name = 'Validation tournament'; validation.scored = false;
    validation.games[0].winner = 'b';
    store(official); store(validation);
    const global = await generateReport({ all: true, outDir: join(root, 'global') });
    const globalJson = JSON.parse(readFileSync(global.jsonPath, 'utf8')), globalMarkdown = readFileSync(global.mdPath, 'utf8');
    expect(globalJson.meta.tournament_ids).toEqual(['fixture']); expect(globalJson.meta.game_count).toBe(1);
    expect(globalJson.meta.unscored_tournament_ids).toEqual([]); expect(globalMarkdown).toContain('Tournaments: fixture.');
    expect(globalMarkdown).not.toContain('validation/game1'); expect(globalMarkdown).not.toContain('Unscored tournaments:');
    expect(globalJson.agents.find((a: { id: string }) => a.id === 'a').wins).toBe(1);
    const selections: [string, ReportOptions][] = [
      ['by-id', { tournamentIds: ['validation'] }],
      ['supplied', { tournaments: validation }],
      ['mixed', { tournamentIds: ['fixture', 'validation'] }],
    ];
    for (const [name, options] of selections) {
      const result = await generateReport({ ...options, outDir: join(root, name) });
      const json = JSON.parse(readFileSync(result.jsonPath, 'utf8')), markdown = readFileSync(result.mdPath, 'utf8');
      expect(json.meta.unscored_tournament_ids).toEqual(['validation']); expect(json.meta.tournament_ids).toContain('validation');
      expect(markdown).toContain('# Tournament Validation Report'); expect(markdown).toContain('Unscored tournaments: validation.');
      expect(markdown).toContain('not official benchmark rankings'); expect(json.meta.game_count).toBe(name === 'mixed' ? 2 : 1);
    }
  });
  it('filters tournament IDs, skips absent directories, and includes only completed games', async () => {
    const t = fixtureTournament(); t.games.push({ ...t.games[0], id: 'pending', status: 'pending' }); store(t);
    const other = fixtureTournament(); other.id = 'other'; store(other);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await generateReport({ tournamentIds: ['fixture', 'missing'], outDir: join(root, 'filtered') });
    const json = JSON.parse(readFileSync(result.jsonPath, 'utf8'));
    expect(warn).toHaveBeenCalled(); expect(json.meta.tournament_ids).toEqual(['fixture']);
    expect(json.meta.game_count).toBe(1); expect(json.agents[0].record.played).toBe(1);
  });
  it('handles empty inputs and missing root with finite defaults', async () => {
    const analyzer = new BenchmarkAnalyzer([]);
    expect(analyzer.agentMetrics()).toEqual([]); expect(analyzer.headToHeadMatrix()).toEqual([]); expect(analyzer.deckMeta()).toEqual([]);
    vi.stubEnv('YGOSIM_TOURNAMENT_DIR', join(root, 'missing-root'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await generateReport({ outDir: join(root, 'empty') });
    expect(readFileSync(result.mdPath, 'utf8').length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(result.jsonPath, 'utf8')).agents).toEqual([]);
    const supplied = await generateReport({ tournaments: fixtureTournament(), outDir: join(root, 'supplied') });
    expect(JSON.parse(readFileSync(supplied.jsonPath, 'utf8')).agents).toHaveLength(2);
  });
  it('parses CLI options and rejects ambiguous or incomplete flags', () => {
    expect(parseReportArgs([])).toEqual({ all: true });
    expect(parseReportArgs(['--', '--tournament', 'fixture', '--out', '/tmp/report'])).toEqual({ tournamentIds: ['fixture'], outDir: '/tmp/report' });
    expect(() => parseReportArgs(['--out'])).toThrow('Missing value');
    expect(() => parseReportArgs(['--all', '--tournament', 'fixture'])).toThrow('either');
    expect(() => parseReportArgs(['--oops'])).toThrow('Unknown option');
  });
});
