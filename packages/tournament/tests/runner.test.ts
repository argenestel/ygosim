import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ busy: new Set<string>(), overlap: false, maxActive: 0, active: 0, games: new Map<string, any>(), behavior: 'win' }));
vi.mock('../src/mcp-server.js', () => ({ createTournamentMcpServer: vi.fn(async ({ game }: any) => {
  const sessions = new Map(game.seats.map((id: string) => [id, { client: { ended: null, state: { turn: 3 }, connected: false, close() {} } }]));
  state.games.set(game.id, sessions);
  state.active++; state.maxActive = Math.max(state.maxActive, state.active);
  for (const id of game.seats) { if (state.busy.has(id)) state.overlap = true; state.busy.add(id); }
  return { sessions, urlFor: (id: string) => `${game.id}/${id}`, close: async () => {
    state.active--; for (const id of game.seats) state.busy.delete(id);
  } };
}) }));
vi.mock('../src/agent-process.js', () => ({ runAgent: vi.fn(async ({ url, signal }: any) => {
  if (state.behavior === 'wait') {
    await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true }));
    return;
  }
  await new Promise(resolve => setTimeout(resolve, 5));
  if (state.behavior === 'crash') return;
  for (const session of state.games.get(url.split('/')[0]).values()) session.client.ended = { winner: 0, reason: 'test-win' };
}) }));
import { parseOptions, runTournament } from '../src/index.js';
afterEach(() => { vi.unstubAllEnvs(); state.busy.clear(); state.games.clear(); state.overlap = false; state.active = 0; state.maxActive = 0; state.behavior = 'win'; });
describe('runner', () => {
  it('validates CLI input', () => {
    expect(parseOptions(['--', '--players', 'codex-sol,claude-opus', '--games', '1'])).toMatchObject({ games: 1, concurrency: 2 });
    expect(() => parseOptions(['--concurrency', '0'])).toThrow();
    expect(() => parseOptions(['--resume', '../escape'])).toThrow();
    expect(() => parseOptions(['--players', 'codex-sol,codex-sol'])).toThrow();
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
      expect(Object.keys(tournament).sort()).toEqual(['createdAt', 'format', 'games', 'id', 'name', 'players', 'status']);
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
});
