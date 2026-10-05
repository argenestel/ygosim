import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ busy: new Set<string>(), overlap: false, maxActive: 0, active: 0, games: new Map<string, any>(), policies: new Map<string, string | undefined>(), behavior: 'win', playerWinner: null as string | null }));
vi.mock('../src/mcp-server.js', () => ({ createTournamentMcpServer: vi.fn(async ({ game, deckPolicy }: any) => {
  for (const id of game.seats) game.decks[id] = { name: 'Fixture', source: 'custom', reason: 'test', main: Array.from({ length: 40 }, (_, i) => i + 1), extra: [] };
  const sessions = new Map(game.seats.map((id: string) => [id, { client: { ended: null, state: { turn: 3 }, connected: false, close() {} } }]));
  state.games.set(game.id, sessions);
  state.policies.set(game.id, deckPolicy);
  state.active++; state.maxActive = Math.max(state.maxActive, state.active);
  for (const id of game.seats) { if (state.busy.has(id)) state.overlap = true; state.busy.add(id); }
  return { sessions, urlFor: (id: string) => `${game.id}/${id}`, authorizationFor: () => '',
    adjudicate: async (winner: string | null, reason: string) => ({ winner: winner === null ? null : game.seats.indexOf(winner), reason }), close: async () => {
    state.active--; for (const id of game.seats) state.busy.delete(id);
  } };
}) }));
vi.mock('../src/agent-process.js', () => ({ runAgent: vi.fn(async ({ url, signal }: any) => {
  if (state.behavior === 'wait') {
    await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true }));
    return;
  }
  await new Promise(resolve => setTimeout(resolve, 5));
  if (state.behavior === 'error') throw new Error('Provider unavailable');
  if (state.behavior === 'crash') {
    if (url.split('/')[1] === state.games.get(url.split('/')[0]).keys().next().value) return;
    await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true }));
    return;
  }
  const sessions = state.games.get(url.split('/')[0]);
  for (const session of sessions.values()) session.client.ended = { winner: state.playerWinner ? [...sessions.keys()].indexOf(state.playerWinner) : 0, reason: 'test-win' };
}) }));
import { archiveAttempt, parseOptions, runTournament } from '../src/index.js';
import { createTournamentMcpServer } from '../src/mcp-server.js';
afterEach(() => { vi.unstubAllEnvs(); state.busy.clear(); state.games.clear(); state.policies.clear(); state.overlap = false; state.active = 0; state.maxActive = 0; state.behavior = 'win'; state.playerWinner = null; });
describe('runner', () => {
  it('validates CLI input', () => {
    expect(parseOptions(['--', '--players', 'codex-sol,claude-opus', '--games', '1'])).toMatchObject({ games: 1, concurrency: 2, sampleDecks: false, customDecks: false });
    expect(parseOptions(['--players', 'codex-sol,claude-opus', '--sample-decks'])).toMatchObject({ sampleDecks: true });
    expect(parseOptions(['--players', 'codex-sol,claude-opus', '--customDecks'])).toMatchObject({ sampleDecks: false, customDecks: true });
    expect(parseOptions(['--players', 'codex-sol,claude-opus', '--custom-decks'])).toMatchObject({ sampleDecks: false, customDecks: true });
    expect(() => parseOptions(['--concurrency', '0'])).toThrow();
    expect(() => parseOptions(['--resume', '../escape'])).toThrow();
    expect(() => parseOptions(['--players', 'codex-sol,codex-sol'])).toThrow();
    expect(parseOptions(['--players', 'pi-grok-46,pi-luna-max', '--best-of', '3'])).toMatchObject({ bestOf: 3, noFinal: true });
    expect(() => parseOptions(['--best-of', '3'])).toThrow();
    expect(() => parseOptions(['--players', 'pi-grok-46,pi-luna-max', '--best-of', '5'])).toThrow();
    expect(() => parseOptions(['--players', 'pi-grok-46,pi-luna-max', '--best-of', '3', '--mirrored'])).toThrow();
    expect(parseOptions(['--players', 'pi-grok-46,pi-luna-max', '--max-minutes', '0'])).toMatchObject({ maxMinutes: 0 });
    expect(() => parseOptions(['--max-minutes', '-1'])).toThrow();
  });
  it('runs disjoint players concurrently, creates final, and writes the contract atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tournament-runner-'));
    vi.stubEnv('YGOSIM_TOURNAMENT_DIR', join(root, 'tournaments'));
    try {
      const options = parseOptions(['--players', 'codex-sol,codex-luna-max,pi-grok-46,claude-opus', '--concurrency', '2']);
      const tournament = await runTournament(options);
      expect(tournament.status).toBe('done'); expect(tournament.games).toHaveLength(7);
      expect(tournament.games.at(-1)?.stage).toBe('final');
      expect(state.overlap).toBe(false); expect(state.maxActive).toBe(2);
      expect(JSON.parse(await readFile(join(root, 'tournaments', tournament.id, 'tournament.json'), 'utf8'))).toEqual(tournament);
      const leaderboard = JSON.parse(await readFile(join(root, 'leaderboard.json'), 'utf8'));
      expect(leaderboard.players).toHaveLength(4);
      expect(Object.keys(tournament).sort()).toEqual(['createdAt', 'deckPolicy', 'format', 'games', 'id', 'name', 'players', 'scored', 'status']);
      expect(tournament.deckPolicy).toBe('custom-only');
      expect(tournament.games.every(game => Number.isInteger(game.seed))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('uses custom-only decks by default and keeps sample decks as an explicit opt-out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tournament-deck-policy-'));
    vi.stubEnv('YGOSIM_TOURNAMENT_DIR', join(root, 'tournaments'));
    try {
      const custom = await runTournament(parseOptions(['--players', 'codex-sol,claude-opus', '--no-final']));
      expect(custom.deckPolicy).toBe('custom-only');
      expect(state.policies.get(custom.games[0]!.id)).toBe('custom-only');
      const samples = await runTournament(parseOptions(['--players', 'codex-sol,claude-opus', '--sample-decks', '--no-final']));
      expect(samples.deckPolicy).toBe('choice');
      expect(state.policies.get(samples.games[0]!.id)).toBe('choice');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('resumes a legacy tournament without a policy in choice mode and guards explicit changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tournament-legacy-policy-'));
    vi.stubEnv('YGOSIM_TOURNAMENT_DIR', join(root, 'tournaments'));
    try {
      const initialOptions = parseOptions(['--players', 'codex-sol,claude-opus,pi-grok-46', '--sample-decks', '--games', '1', '--no-final']);
      const initial = await runTournament(initialOptions);
      const path = join(root, 'tournaments', initial.id, 'tournament.json');
      const legacy = JSON.parse(await readFile(path, 'utf8'));
      delete legacy.deckPolicy;
      await writeFile(path, JSON.stringify(legacy));

      const resumed = await runTournament({ ...parseOptions(['--players', 'codex-sol,claude-opus,pi-grok-46', '--no-final']), games: undefined, resume: initial.id });
      expect(resumed.deckPolicy).toBeUndefined();
      expect(state.policies.get(resumed.games.at(-1)!.id)).toBe('choice');

      const customAlias = parseOptions(['--players', 'codex-sol,claude-opus,pi-grok-46', '--custom-decks', '--no-final']);
      await expect(runTournament({ ...customAlias, games: undefined, resume: initial.id })).rejects.toThrow('Changing deck policy requires a fresh tournament and validation');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('limits games and resumes remaining games without rerunning completed ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tournament-resume-'));
    vi.stubEnv('YGOSIM_TOURNAMENT_DIR', join(root, 'tournaments'));
    try {
      const options = parseOptions(['--players', 'codex-sol,codex-luna-max,claude-opus', '--games', '1', '--no-final']);
      const initial = await runTournament(options);
      expect(initial.games.filter(g => g.status === 'done')).toHaveLength(1); expect(initial.status).toBe('running');
      const startedAt = initial.games[0]!.startedAt;
      const resumed = await runTournament({ ...options, games: undefined, resume: initial.id });
      expect(resumed.status).toBe('done'); expect(resumed.games).toHaveLength(3);
      expect(resumed.games[0]!.startedAt).toBe(startedAt);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  for (const behavior of ['wait', 'crash']) it(`settles ${behavior === 'wait' ? 'wall timeout as a draw' : 'exhausted agent as a loss'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'tournament-end-'));
    vi.stubEnv('YGOSIM_TOURNAMENT_DIR', join(root, 'tournaments'));
    state.behavior = behavior;
    try {
      const result = await runTournament(parseOptions(['--players', 'codex-sol,claude-opus', '--no-final', '--max-minutes', '0.001']));
      expect(result.status).toBe('done');
      expect(result.games[0]!.reason).toBe(behavior === 'wait' ? 'timeout' : 'agent-crash');
      expect(result.games[0]!.winner).toBe(behavior === 'wait' ? null : result.games[0]!.seats[1]);
      const bridge = await vi.mocked(createTournamentMcpServer).mock.results.at(-1)!.value;
      expect(bridge.adjudicate).toBeDefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('keeps interrupted games resumable and cleans up active agents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tournament-interrupt-'));
    vi.stubEnv('YGOSIM_TOURNAMENT_DIR', join(root, 'tournaments'));
    state.behavior = 'wait';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    try {
      const result = await runTournament(parseOptions(['--players', 'codex-sol,claude-opus', '--no-final']), controller.signal);
      expect(result.status).toBe('running'); expect(result.games[0]!.endedAt).toBeUndefined();
      expect(state.active).toBe(0);
    } finally { clearTimeout(timer); await rm(root, { recursive: true, force: true }); }
  });
  it('does not invent a wall-time result when the whole-duel cutoff is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tournament-unlimited-')); vi.stubEnv('YGOSIM_TOURNAMENT_DIR', join(root, 'tournaments'));
    state.behavior = 'wait'; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 120);
    try {
      const result = await runTournament(parseOptions(['--players', 'codex-sol,claude-opus', '--no-final', '--max-minutes', '0']), controller.signal);
      expect(result.games[0]).toMatchObject({ status: 'running', winner: null });
      expect(result.games[0].reason).toBeUndefined(); expect(result.games[0].endedAt).toBeUndefined();
    } finally { clearTimeout(timer); await rm(root, { recursive: true, force: true }); }
  });
  it('preserves an unplayed final at the game limit and lets --no-final skip it on resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tournament-final-limit-'));
    vi.stubEnv('YGOSIM_TOURNAMENT_DIR', join(root, 'tournaments'));
    try {
      const options = parseOptions(['--players', 'codex-sol,claude-opus', '--games', '1']);
      const initial = await runTournament(options);
      expect(initial.status).toBe('running'); expect(initial.games.at(-1)?.status).toBe('pending');
      expect(initial.games.at(-1)?.stage).toBe('final');
      const resumed = await runTournament({ ...options, noFinal: true, resume: initial.id });
      expect(resumed.status).toBe('done'); expect(resumed.games).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('recovers a dead runner lock without letting simultaneous resumes share ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tournament-lock-'));
    vi.stubEnv('YGOSIM_TOURNAMENT_DIR', join(root, 'tournaments'));
    try {
      const options = parseOptions(['--players', 'codex-sol,codex-luna-max,claude-opus', '--games', '1', '--no-final']);
      const initial = await runTournament(options);
      const lock = join(root, 'tournaments', initial.id, '.runner-lock');
      await mkdir(lock); await writeFile(join(lock, 'owner-2147483647-stale'), '');
      const attempts = await Promise.allSettled([
        runTournament({ ...options, games: undefined, resume: initial.id }),
        runTournament({ ...options, games: undefined, resume: initial.id }),
      ]);
      expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(state.overlap).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('keeps validation tournaments out of the official leaderboard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tournament-validation-'));
    vi.stubEnv('YGOSIM_TOURNAMENT_DIR', join(root, 'tournaments'));
    try {
      const result = await runTournament(parseOptions(['--players', 'codex-sol,claude-opus', '--validate']));
      expect(result.scored).toBe(false);
      expect(result.games).toHaveLength(1);
      expect(result.validation?.passed).toBe(false);
      expect(JSON.parse(await readFile(join(root, 'leaderboard.json'), 'utf8')).players).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('pauses on infrastructure failures without awarding a win', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tournament-infra-'));
    vi.stubEnv('YGOSIM_TOURNAMENT_DIR', join(root, 'tournaments')); state.behavior = 'error';
    try {
      const result = await runTournament(parseOptions(['--players', 'codex-sol,claude-opus', '--no-final']));
      expect(result.status).toBe('running');
      expect(result.games[0]).toMatchObject({ status: 'error', winner: null });
      expect(JSON.parse(await readFile(join(root, 'leaderboard.json'), 'utf8')).players.every((player: any) => player.played === 0)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('archives interrupted attempt files before starting another attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tournament-attempt-'));
    try {
      const game: any = { id: 'g1', status: 'running', seats: ['a', 'b'], winner: null, decks: {}, stats: {}, attempt: 1, seed: 42 };
      const current = join(root, 'games', 'g1'); await mkdir(current, { recursive: true });
      await writeFile(join(current, 'replay.jsonl'), 'original replay');
      expect(await archiveAttempt(root, game)).toBe(current);
      expect(game.attempt).toBe(2);
      expect(await readFile(join(root, 'attempts', 'g1', '1', 'replay.jsonl'), 'utf8')).toBe('original replay');
      expect(JSON.parse(await readFile(join(root, 'attempts', 'g1', '1', 'attempt.json'), 'utf8')).seed).toBe(42);
      await writeFile(join(current, 'replay.jsonl'), 'second replay');
      await archiveAttempt(root, game);
      expect(game.attempt).toBe(3);
      expect(await readFile(join(root, 'attempts', 'g1', '2', 'replay.jsonl'), 'utf8')).toBe('second replay');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rejects symlinked game storage without writing into its target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tournament-attempt-link-'));
    try {
      const dir = join(root, 'tournament'); const outside = join(root, 'outside');
      await mkdir(dir); await mkdir(outside); await symlink(outside, join(dir, 'games'));
      const game: any = { id: 'g1', status: 'running', seats: ['a', 'b'], winner: null, decks: {}, stats: {} };
      await expect(archiveAttempt(dir, game)).rejects.toThrow('Unsafe games directory');
      await expect(access(join(outside, 'g1'))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('stops a best-of-three sweep after two wins without launching a third duel or final', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tournament-series-sweep-')); vi.stubEnv('YGOSIM_TOURNAMENT_DIR', join(root, 'tournaments'));
    state.playerWinner = 'pi-grok-46';
    try {
      const result = await runTournament(parseOptions(['--players', 'pi-grok-46,pi-luna-max', '--best-of', '3', '--seed', '42']));
      expect(result.status).toBe('done'); expect(result.format).toBe('best-of-three'); expect(result.games).toHaveLength(2);
      expect(result.series).toMatchObject({ complete: true, winner: 'pi-grok-46', wins: { 'pi-grok-46': 2, 'pi-luna-max': 0 } });
      expect(result.games.map(game => game.seats)).toEqual([['pi-grok-46', 'pi-luna-max'], ['pi-luna-max', 'pi-grok-46']]);
      expect(result.players.find(player => player.id === 'pi-luna-max')).toMatchObject({ cli: 'pi', model: 'openai-codex/gpt-6-luna', effort: 'max' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('plays a deciding third duel after a split and resumes without replaying the first game', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tournament-series-split-')); vi.stubEnv('YGOSIM_TOURNAMENT_DIR', join(root, 'tournaments'));
    try {
      const options = parseOptions(['--players', 'pi-grok-46,pi-luna-max', '--best-of', '3', '--seed', '42', '--games', '1']);
      const initial = await runTournament(options); const startedAt = initial.games[0].startedAt;
      expect(initial.status).toBe('running'); expect(initial.series?.complete).toBe(false);
      const result = await runTournament({ ...options, games: undefined, resume: initial.id });
      expect(result.games).toHaveLength(3); expect(result.status).toBe('done'); expect(result.games[0].startedAt).toBe(startedAt);
      expect(result.series).toMatchObject({ complete: true, winner: 'pi-grok-46', wins: { 'pi-grok-46': 2, 'pi-luna-max': 1 } });
      expect(result.games.every(game => game.stage === 'series')).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
