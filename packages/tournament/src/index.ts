import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROSTER } from './roster.js';
import { roundRobin, finalGame } from './schedule.js';
import { computeLeaderboard, computeStandings } from './standings.js';
import { atomicWrite, readTournaments, tournamentDir } from './storage.js';
import { createTournamentMcpServer } from './mcp-server.js';
import { runAgent } from './agent-process.js';
import { agentPrompt } from './agent-prompt.js';
import { acquireLock } from './lock.js';
import type { Game, Tournament } from './types.js';

export interface RunnerOptions {
  name: string; players: string[]; concurrency: number; games?: number; maxMinutes: number;
  noFinal: boolean; resume?: string; server: string;
}
export function parseOptions(argv: string[]): RunnerOptions {
  const { values } = parseArgs({ args: argv[0] === '--' ? argv.slice(1) : argv, options: {
    name: { type: 'string', default: 'Agent tournament' }, players: { type: 'string' },
    concurrency: { type: 'string', default: '2' }, games: { type: 'string' },
    'max-minutes': { type: 'string', default: '90' }, 'no-final': { type: 'boolean', default: false },
    resume: { type: 'string' }, server: { type: 'string', default: 'ws://localhost:7777' },
  } });
  const positive = (value: string, name: string, integer = true) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || (integer && !Number.isInteger(number))) throw new Error(`${name} must be a positive ${integer ? 'integer' : 'number'}`);
    return number;
  };
  const players = values.players?.split(',').map(id => id.trim()) ?? ROSTER.map(p => p.id);
  if (players.length < 2 || new Set(players).size !== players.length || players.some(id => !ROSTER.some(p => p.id === id))) throw new Error('Choose at least two distinct roster IDs');
  if (values.resume && !/^[a-zA-Z0-9_-]+$/.test(values.resume)) throw new Error('Invalid tournament ID');
  const server = new URL(values.server!);
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(server.protocol)) throw new Error('Invalid server URL');
  return { name: values.name!, players, concurrency: positive(values.concurrency!, '--concurrency'),
    games: values.games === undefined ? undefined : positive(values.games, '--games'),
    maxMinutes: positive(values['max-minutes']!, '--max-minutes', false), noFinal: values['no-final']!, resume: values.resume, server: server.toString() };
}

function emptyStats(): Game['stats'][string] {
  return { decisions: 0, avgDecisionMs: 0, invalid: 0, toolCalls: 0, resumes: 0, reasonsGiven: 0 };
}

async function playGame(tournament: Tournament, game: Game, dir: string, options: RunnerOptions, persist: () => Promise<void>, signal: AbortSignal): Promise<void> {
  const gameDir = join(dir, 'games', game.id);
  // A resumed interrupted game starts a fresh duel, with files matching that attempt.
  await rm(gameDir, { recursive: true, force: true });
  await mkdir(gameDir, { recursive: true });
  game.status = 'running'; game.startedAt = new Date().toISOString();
  game.winner = null; game.decks = {}; game.stats = Object.fromEntries(game.seats.map(id => [id, emptyStats()]));
  delete game.error; delete game.endedAt; delete game.reason; delete game.turns;
  await persist();
  let bridge: Awaited<ReturnType<typeof createTournamentMcpServer>> | undefined;
  const agents = new AbortController();
  const stop = () => agents.abort();
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const tasks: Promise<void>[] = [];
  try {
    bridge = await createTournamentMcpServer({ game, gameDir, server: options.server, onChange: persist });
    const current = bridge;
    const exhausted = new Set<string>();
    const deadline = Date.now() + options.maxMinutes * 60_000;
    const ended = () => game.status !== 'running' || [...current.sessions.values()].some(session => session.client.ended !== null);
    for (const id of game.seats) {
      const player = tournament.players.find(p => p.id === id)!;
      tasks.push(runAgent({ player, gameDir, url: current.urlFor(id), prompt: agentPrompt(tournament, game, player), signal: agents.signal,
        isEnded: ended, onResume: async () => { game.stats[id]!.resumes++; await persist(); },
      }).then(() => { if (!agents.signal.aborted && !ended()) exhausted.add(id); }, error => {
        game.error = `${id}: ${String(error)}`; exhausted.add(id);
      }));
    }
    while (!signal.aborted) {
      const result = [...current.sessions.values()].find(session => session.client.ended)?.client.ended;
      game.turns = Math.max(0, ...[...current.sessions.values()].map(session => session.client.state?.turn ?? 0));
      if (result) {
        game.winner = result.winner === null ? null : game.seats[result.winner]; game.reason = result.reason; game.status = 'done'; break;
      }
      if (Date.now() >= deadline || exhausted.size) {
        const loser = exhausted.values().next().value as string | undefined;
        game.winner = loser ? game.seats.find(id => id !== loser)! : null;
        game.reason = loser ? 'agent-crash' : 'timeout'; game.status = 'done';
        const session = current.sessions.get(loser ?? game.seats[0]);
        if (session?.client.connected && session.client.room) {
          session.client.send({ type: 'surrender' });
          // Give the spectator time to save the engine's terminal broadcast.
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        break;
      }
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 100);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    if (!signal.aborted) game.endedAt = new Date().toISOString();
  } catch (error) {
    if (!signal.aborted) { game.status = 'error'; game.error = String(error); game.endedAt = new Date().toISOString(); }
  } finally {
    agents.abort(); signal.removeEventListener('abort', stop);
    await Promise.allSettled(tasks);
    await bridge?.close();
    await persist();
  }
}

export async function runTournament(options: RunnerOptions, signal: AbortSignal = new AbortController().signal): Promise<Tournament> {
  const root = tournamentDir();
  const id = options.resume ?? `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  const releaseRunner = await acquireLock(join(dir, '.runner-lock'));
  let tournament: Tournament;
  try {
    tournament = options.resume
      ? JSON.parse(await readFile(join(dir, 'tournament.json'), 'utf8')) as Tournament
      : { id, name: options.name, createdAt: new Date().toISOString(), status: 'running', format: 'round-robin+final',
        players: options.players.map(id => ({ ...ROSTER.find(p => p.id === id)! })), games: roundRobin(options.players) };
    if (tournament.id !== id) throw new Error('Tournament ID does not match directory');
    const playerIds = new Set(tournament.players.map(player => player.id));
    if (tournament.players.some(player => !/^[a-zA-Z0-9_-]+$/.test(player.id))
      || tournament.games.some(game => !/^[a-zA-Z0-9_-]+$/.test(game.id)
        || game.seats.length !== 2 || game.seats[0] === game.seats[1] || game.seats.some(seat => !playerIds.has(seat)))) {
      throw new Error('Invalid game or player IDs in tournament');
    }
    if (options.resume) for (const game of tournament.games) if (game.status !== 'done') game.status = 'pending';
    if (options.noFinal) tournament.games = tournament.games.filter(game => game.stage !== 'final' || game.status === 'done');
    tournament.status = 'running';
    let writes = Promise.resolve();
    const persist = () => {
      writes = writes.catch(() => {}).then(async () => {
        await atomicWrite(join(dir, 'tournament.json'), tournament);
        const releaseLeaderboard = await acquireLock(join(root, '.leaderboard-lock'), 10_000);
        try { atomicWrite(join(dirname(root), 'leaderboard.json'), computeLeaderboard(readTournaments(root))); }
        finally { await releaseLeaderboard(); }
      });
      return writes;
    };
    await persist();
    console.log(`Tournament ${id}: ${tournament.players.length} players, ${tournament.games.length} games (${dir})`);
    const active = new Map<Game, Promise<void>>();
    const busy = new Set<string>();
    let launched = 0;
    while (!signal.aborted) {
      const rr = tournament.games.filter(g => g.stage === 'round-robin');
      if (!options.noFinal && rr.every(g => g.status === 'done') && !tournament.games.some(g => g.stage === 'final')) {
        const top = computeStandings({ ...tournament, games: rr }).slice(0, 2);
        tournament.games.push(finalGame([top[0]!.id, top[1]!.id], Math.max(...rr.map(g => g.round)) + 1));
        await persist();
      }
      for (const game of tournament.games) {
        if (active.size >= options.concurrency || launched >= (options.games ?? Infinity) || signal.aborted) break;
        if (game.status !== 'pending' || game.seats.some(id => busy.has(id))) continue;
        // A pending final restored from disk must still wait for round-robin reruns.
        if (game.stage === 'final' && !rr.every(g => g.status === 'done')) continue;
        if (game.stage === 'final') {
          const top = computeStandings({ ...tournament, games: rr }).slice(0, 2);
          game.seats = [top[0]!.id, top[1]!.id];
          if (game.seats.some(id => busy.has(id))) continue;
        }
        for (const id of game.seats) busy.add(id);
        launched++;
        const task = playGame(tournament, game, dir, options, persist, signal).finally(() => {
          active.delete(game); for (const id of game.seats) busy.delete(id);
          console.log(`${game.id}: ${game.status}, ${game.winner ?? 'draw'} (${game.reason ?? game.error ?? 'interrupted'})`);
        });
        active.set(game, task);
      }
      if (!active.size) break;
      await Promise.race(active.values());
    }
    await Promise.all(active.values());
    tournament.status = tournament.games.every(g => g.status === 'done') ? 'done' : 'running';
    await persist();
    return tournament;
  } finally { await releaseRunner(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const tournament = await runTournament(parseOptions(process.argv.slice(2)), controller.signal);
    if (tournament.games.some(game => game.status === 'error')) process.exitCode = 1;
    if (controller.signal.aborted) process.exitCode = 130;
  }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
