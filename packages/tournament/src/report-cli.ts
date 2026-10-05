import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchmarkAnalyzer, readDecisions, tournamentRoot, validId } from './analysis.js';
import type { AgentMetrics, RecordStats, Tournament } from './analysis.js';

export interface ReportOptions {
  tournaments?: Tournament[] | Tournament;
  tournamentIds?: string[];
  all?: boolean;
  outDir?: string;
}
const defaultOutput = fileURLToPath(new URL('../../../data/benchmark/', import.meta.url));
const escape = (value: unknown): string => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ').replace(/([\\`*_\[\]])/g, '\\$1');
const number = (value: number): string => value.toFixed(1);
const percent = (value: number): string => `${(100 * value).toFixed(1)}%`;
const ratingInterval = (ci: [number, number]): string => `${number(ci[0])}–${number(ci[1])}`;
const rateInterval = (ci: [number, number]): string => `${percent(ci[0])}–${percent(ci[1])}`;
const timingSource = (source: AgentMetrics['decision_metrics']['latency_source']): string => ({
  response: 'Response latency', legacy_tool_wait: 'Legacy tool-wait time',
  mixed: 'Mixed response / legacy tool-wait time', unavailable: 'Timing unavailable',
})[source];
const record = (r: RecordStats): string => `${r.wins}/${r.losses}/${r.draws}`;
const table = (headers: string[], rows: unknown[][]): string => [
  `| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`,
  ...rows.map(row => `| ${row.map(escape).join(' | ')} |`),
].join('\n');

async function loadTournaments(options: ReportOptions): Promise<Tournament[]> {
  if (options.tournaments) {
    const supplied = Array.isArray(options.tournaments) ? options.tournaments : [options.tournaments];
    return supplied.filter(t => !options.tournamentIds?.length || options.tournamentIds.includes(t.id));
  }
  let ids = options.tournamentIds;
  if (!ids?.length) {
    try { ids = (await readdir(tournamentRoot(), { withFileTypes: true })).filter(e => e.isDirectory() && validId(e.name)).map(e => e.name).sort(); }
    catch { console.warn(`Warning: tournament directory unavailable: ${tournamentRoot()}`); return []; }
  }
  const tournaments: Tournament[] = [];
  for (const id of [...new Set(ids)]) {
    if (!validId(id)) { console.warn(`Warning: skipping invalid tournament ID: ${id}`); continue; }
    try {
      const value: unknown = JSON.parse(await readFile(join(tournamentRoot(), id, 'tournament.json'), 'utf8'));
      if (!value || typeof value !== 'object') throw new Error('Invalid tournament data');
      const t = value as Tournament;
      if (t.id !== id || !Array.isArray(t.players) || !Array.isArray(t.games)) throw new Error('Invalid tournament data');
      tournaments.push(t);
    } catch (error) { console.warn(`Warning: skipping tournament ${id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return tournaments;
}

function profile(agent: AgentMetrics): string {
  const d = agent.decision_metrics, r = agent.reason_stats, picks = agent.deck_picks, tools = agent.tool_stats;
  const timing = d.timed_decisions ? `average ${number(d.avg_ms)} ms; ${d.quantile_samples ? `median ${number(d.median_ms)} ms; p90 ${number(d.p90_ms)} ms` : 'median/p90 unavailable (no timed decision logs)'}; ${d.timed_decisions} timed decisions; ${d.quantile_samples} logged timing samples.` : 'No recorded timing samples.';
  return [
    `### ${escape(agent.label)} (${escape(agent.id)})`, '',
    `Elo: **${number(agent.elo)}** (95% BT CI: ${ratingInterval(agent.elo_ci)}) · Record (W/L/D): ${record(agent.record)} · Win rate: ${percent(agent.win_rate)} (95% Wilson CI: ${rateInterval(agent.win_rate_ci)}) · Average turns: ${number(agent.avg_turns)}`, '',
    `Seat performance: first ${record(agent.seat_performance.first)} (${percent(agent.win_rate_as_first)}); second ${record(agent.seat_performance.second)} (${percent(agent.win_rate_as_second)}).`, '',
    `${timingSource(d.latency_source)}: ${timing} ${d.total_decisions} decisions (${number(d.per_game)} per game).`, '',
    `Reason lengths: average ${number(r.avg_length)}, median ${number(r.median_length)}, p90 ${number(r.p90_length)} characters. Reason given rate: ${percent(r.given_rate)}. Invalid action rate: ${percent(agent.invalid_rate)}.`, '',
    `Deck preferences: ${picks.sample} sample picks, ${picks.custom} custom picks; diversity ${percent(picks.diversity)}; average custom deck size ${number(picks.avg_custom_size)} cards.`, '',
    table(['Deck', 'W/L/D', 'Picks', 'Win rate'], agent.decks.map(deck => [deck.name, record(deck), deck.picks, percent(deck.win_rate)])), '',
    table(['Stage', 'Played', 'W/L/D', 'Win rate'], Object.entries(agent.stages).map(([stage, stats]) => [stage, stats.played, record(stats), percent(stats.win_rate)])), '',
    `Tool usage: ${tools.total_calls} calls, ${tools.failures} failures, ${tools.resumes} resumes. Pass rate: ${percent(agent.pass_rate)}.`, '',
  ].join('\n');
}

export async function generateReport(options: ReportOptions = {}): Promise<{ mdPath: string; jsonPath: string }> {
  const explicit = Boolean(options.tournamentIds?.length || options.tournaments);
  const analyzer = new BenchmarkAnalyzer(await loadTournaments(options), { includeUnscored: explicit, includeLegacy: explicit });
  const tournaments = analyzer.tournaments;
  const agents = analyzer.agentMetrics().sort((a, b) => b.elo - a.elo || (b.wins * 3 + b.draws) - (a.wins * 3 + a.draws) || a.id.localeCompare(b.id));
  const head_to_head = analyzer.headToHeadMatrix(), deck_meta = analyzer.deckMeta();
  const data = { meta: { generated_at: new Date().toISOString(), tournament_ids: tournaments.map(t => t.id), unscored_tournament_ids: tournaments.filter(t => t.scored === false).map(t => t.id), legacy_tournament_ids: tournaments.filter(t => t.scored === undefined).map(t => t.id), game_count: analyzer.completedGames.length }, agents, head_to_head, deck_meta };
  const sections = [
    data.meta.legacy_tournament_ids.length ? '# Tournament Historical Report' : data.meta.unscored_tournament_ids.length ? '# Tournament Validation Report' : '# Tournament Benchmark Report', '',
    `Generated: ${data.meta.generated_at}. ${agents.length} agents, ${analyzer.completedGames.length} completed games. Tournaments: ${tournaments.map(t => escape(t.id)).join(', ') || 'none'}.`, '',
    ...(data.meta.unscored_tournament_ids.length ? [`Unscored tournaments: ${data.meta.unscored_tournament_ids.map(escape).join(', ')}. These results are not official benchmark rankings.`, ''] : []),
    ...(data.meta.legacy_tournament_ids.length ? [`Legacy tournaments without an explicit scored marker: ${data.meta.legacy_tournament_ids.map(escape).join(', ')}. These historical results are not launch-validated benchmark rankings.`, ''] : []),
    '## Leaderboard', '',
    table(['Agent', 'Elo', '95% BT CI', 'W/L/D', 'Win rate', '95% Wilson CI', 'Avg turns', 'Avg recorded ms', 'Timing source'], agents.map(a => [a.label, number(a.elo), ratingInterval(a.elo_ci), record(a.record), percent(a.win_rate), rateInterval(a.win_rate_ci), number(a.avg_turns), a.decision_metrics.timed_decisions ? number(a.decision_metrics.avg_ms) : '—', timingSource(a.decision_metrics.latency_source)])), '',
    '## Per-Agent Profile Cards', '', ...agents.map(profile),
    '## Head-to-Head', '', 'Cells show row agent W/L/D and win rate against the column agent.', '',
    table(['Agent', ...agents.map(a => escape(a.label))], agents.map(a => [a.label, ...agents.map(b => {
      if (a.id === b.id) return '—';
      const h = head_to_head.find(h => h.agent_a === a.id && h.agent_b === b.id);
      return h ? `${h.record.a_wins}/${h.record.b_wins}/${h.record.draws} (${percent(h.win_rate)})` : '—';
    })])), '',
    '## H2H Bradley-Terry Ratings', '',
    'Joint Bradley–Terry strengths are centered on 1500, with a half-win/half-loss baseline prior. Intervals are percentile bootstrap estimates (1000 resamples, seed 42); draws count as half a win. Small or disconnected schedules provide limited evidence.', '',
    table(['Agent', 'Elo estimate', '95% BT CI'], agents.map(a => [a.label, number(a.elo), ratingInterval(a.elo_ci)])), '',
    'Pairwise estimates use half-win smoothing and a 1500 pair midpoint. Each row estimates the first agent; reversing the pair mirrors its rating around 1500.', '',
    table(['Agent', 'Opponent', 'Elo estimate', '95% BT CI'], head_to_head.map(h => [h.agent_a, h.agent_b, number(h.bradley_terry.estimate), ratingInterval(h.bradley_terry.ci)])), '',
    '## Deck Meta', '',
    table(['Deck', 'Source', 'Picks', 'Pick rate', 'Wins', 'Win rate', '95% Wilson CI', 'Picked by'], deck_meta.map(d => [d.name, d.source, d.picks, percent(d.picks / (deck_meta.reduce((sum, deck) => sum + deck.picks, 0) || 1)), d.wins, percent(d.win_rate), `${percent(d.ci[0])}–${percent(d.ci[1])}`, Object.entries(d.picked_by).map(([id, picks]) => `${id}: ${picks}`).join(', ')])), '',
    '## Notable Games', '',
  ];
  const timed = analyzer.completedGames.filter(({ game }) => typeof game.turns === 'number' && Number.isFinite(game.turns)).sort((a, b) => a.game.turns! - b.game.turns! || a.game.id.localeCompare(b.game.id));
  const describe = ({ tournament, game }: typeof timed[number]) => `${escape(tournament.id)}/${escape(game.id)}: ${game.turns} turns (${game.seats.map(escape).join(' vs ')})`;
  if (timed.length) sections.push(`- Longest game: ${describe(timed[timed.length - 1])}`, `- Shortest game: ${describe(timed[0])}`, '');
  else sections.push('No completed games with recorded turn counts.', '');
  const ratings = new Map(agents.map(a => [a.id, a.elo]));
  const upsets = analyzer.completedGames.flatMap(({ tournament, game }) => {
    if (!game.winner) return [];
    const loser = game.seats.find(id => id !== game.winner), gap = (ratings.get(loser || '') || 1500) - (ratings.get(game.winner) || 1500);
    return gap > 0 ? [{ tournament, game, loser, gap }] : [];
  }).sort((a, b) => b.gap - a.gap).slice(0, 3);
  sections.push('### Upsets', '', ...(upsets.length ? upsets.map(u => `- ${escape(u.tournament.id)}/${escape(u.game.id)}: ${escape(u.game.winner)} defeated ${escape(u.loser)} (rating gap ${number(u.gap)}).`) : ['No upsets against the final fitted ratings.']), '', '### Deck Choice Reasoning', '');
  for (const { tournament, game } of analyzer.completedGames) for (const id of game.seats) {
    const deck = game.decks?.[id]; if (!deck) continue;
    const reasons = readDecisions(tournament.id, game.id, id).filter(d => typeof d.reason === 'string' && /deck/i.test(`${d.promptKind || ''} ${d.phase || ''} ${d.promptId || ''}`));
    const excerpt = reasons.map(d => d.reason).find(reason => reason?.length) || deck.reason || '';
    sections.push(`- ${escape(tournament.id)}/${escape(game.id)} · ${escape(id)} · ${escape(deck.name)}: ${excerpt ? escape(excerpt.slice(0, 200)) : 'No recorded deck-choice reason.'}`);
  }
  sections.push('',
    'Rates use completed games only. Draws are included in win-rate denominators. Global reports require scored:true; explicit tournament IDs or supplied tournaments may include labeled legacy history or unscored validation. Wilson intervals describe win rates; Bradley–Terry intervals describe fitted strengths.', '',
    'Response latency measures prompt delivery to action submission. Unmarked legacy ms measured tool waiting time, not agent thinking time. Mixed timing combines both sources for compatibility and is not a comparable response-latency metric. Tool duration (toolMs) is separate from response latency.', '',
    'Timing averages prefer valid decision logs. When no logged timing is available for a game, response latency falls back to the stored per-game average, weighted by timedDecisions; legacy timing uses decision count. Missing timing is excluded, not counted as zero. Median/p90 use timed decision logs only; quantile_samples records their sample count, and zero means those quantiles are unavailable. Reason lengths and pass rates use available decision logs; string choices require recorded optionIds to resolve their labels. Deck names with different sources are separate meta entries.', '');
  const outDir = resolve(options.outDir || defaultOutput), mdPath = join(outDir, 'REPORT.md'), jsonPath = join(outDir, 'benchmark.json');
  await mkdir(outDir, { recursive: true });
  await writeFile(mdPath, sections.join('\n'), 'utf8');
  await writeFile(jsonPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`Generated report: ${mdPath}, ${agents.length} agents, ${analyzer.completedGames.length} games`);
  return { mdPath, jsonPath };
}

export function parseReportArgs(args: string[]): ReportOptions {
  const options: ReportOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') continue;
    if (arg === '--all') options.all = true;
    else if (arg === '--tournament' || arg === '--out') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--out') options.outDir = value;
      else (options.tournamentIds ||= []).push(value);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.all && options.tournamentIds?.length) throw new Error('Use either --all or --tournament');
  if (!options.tournamentIds?.length) options.all = true;
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => generateReport(parseReportArgs(process.argv.slice(2)))).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
