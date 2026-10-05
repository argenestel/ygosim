import { parseArgs } from 'node:util';
import { randomInt, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getRosterPlayer, ROSTER } from './roster.js';
import { roundRobin, finalGame, seriesGame, seriesResult } from './schedule.js';
import { computeLeaderboard, computeStandings } from './standings.js';
import { atomicWrite, readTournaments, tournamentDir } from './storage.js';
import { createTournamentMcpServer } from './mcp-server.js';
import { runAgent } from './agent-process.js';
import { agentPrompt } from './agent-prompt.js';
import { acquireLock } from './lock.js';
import { modelMatches, preflight, requireValidation, validationResult } from './preflight.js';
import type { Game, Tournament } from './types.js';

export interface RunnerOptions {
  name: string; players: string[]; concurrency: number; games?: number; maxMinutes: number;
  noFinal: boolean; resume?: string; server: string;
  validate?: boolean; preflightOnly?: boolean; validatedBy?: string;
  seed?: number; cycles?: number; mirrored?: boolean; audit?: Tournament['audit'];
  bestOf?: 3;
  sampleDecks?: boolean;
  /** Deprecated compatibility aliases. New tournaments are custom-only by default. */
  customDecks?: boolean;
}
export function parseOptions(argv: string[]): RunnerOptions {
  const { values } = parseArgs({ args: argv[0] === '--' ? argv.slice(1) : argv, options: {
    name: { type: 'string', default: 'Agent tournament' }, players: { type: 'string' },
    concurrency: { type: 'string', default: '2' }, games: { type: 'string' },
    'max-minutes': { type: 'string', default: '90' }, 'no-final': { type: 'boolean', default: false },
    resume: { type: 'string' }, server: { type: 'string', default: 'ws://localhost:7777' },
    validate: { type: 'boolean', default: false }, preflight: { type: 'boolean', default: false },
    'validated-by': { type: 'string' }, seed: { type: 'string' }, cycles: { type: 'string', default: '1' },
    mirrored: { type: 'boolean', default: false },
    'best-of': { type: 'string' },
    'sample-decks': { type: 'boolean', default: false },
    'custom-decks': { type: 'boolean', default: false },
    customDecks: { type: 'boolean', default: false },
  } });
  const positive = (value: string, name: string, integer = true) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || (integer && !Number.isInteger(number))) throw new Error(`${name} must be a positive ${integer ? 'integer' : 'number'}`);
    return number;
  };
  const players = values.players?.split(',').map(id => id.trim()) ?? ROSTER.map(p => p.id);
  if (players.length < 2 || new Set(players).size !== players.length || players.some(id => !getRosterPlayer(id))) throw new Error('Choose at least two distinct roster IDs');
  if (values['best-of'] !== undefined && (values['best-of'] !== '3' || players.length !== 2 || values.mirrored || values.cycles !== '1' || values.validate)) throw new Error('--best-of 3 requires exactly two players and cannot combine with validation, cycles or mirroring');
  if (values.resume && !/^[a-zA-Z0-9_-]+$/.test(values.resume)) throw new Error('Invalid tournament ID');
  if (values['validated-by'] && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(values['validated-by'])) throw new Error('Invalid validation ID');
  const seed = values.seed === undefined ? undefined : Number(values.seed);
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) throw new Error('--seed must be a uint32 integer');
  const server = new URL(values.server!);
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(server.protocol) || server.username || server.password || server.search || server.hash) throw new Error('Invalid server URL');
  return { name: values.name!, players, concurrency: positive(values.concurrency!, '--concurrency'),
    games: values.games === undefined ? undefined : positive(values.games, '--games'),
    maxMinutes: values['max-minutes'] === '0' ? 0 : positive(values['max-minutes']!, '--max-minutes', false), noFinal: values['no-final']! || values.validate! || values['best-of'] !== undefined, resume: values.resume, server: server.toString(),
    validate: values.validate, preflightOnly: values.preflight, validatedBy: values['validated-by'], seed,
    cycles: positive(values.cycles!, '--cycles'), mirrored: values.mirrored, bestOf: values['best-of'] === '3' ? 3 : undefined,
    sampleDecks: values['sample-decks'], customDecks: values['custom-decks'] || values.customDecks };
}

function requestedDeckPolicy(options: Pick<RunnerOptions, 'sampleDecks'>): NonNullable<Tournament['deckPolicy']> {
  return options.sampleDecks ? 'choice' : 'custom-only';
}

function storedDeckPolicy(tournament: Pick<Tournament, 'deckPolicy' | 'audit'>): NonNullable<Tournament['deckPolicy']> {
  // Tournaments written before deckPolicy was introduced used sample choices.
  return tournament.deckPolicy ?? tournament.audit?.deckPolicy ?? 'choice';
}

function hasExplicitDeckPolicy(options: Pick<RunnerOptions, 'sampleDecks' | 'customDecks'>): boolean {
  return options.sampleDecks === true || options.customDecks === true;
}

function assertResumeDeckPolicy(options: RunnerOptions, prior: Tournament): void {
  if (!hasExplicitDeckPolicy(options)) return;
  if (requestedDeckPolicy(options) !== storedDeckPolicy(prior)) {
    throw new Error('Changing deck policy requires a fresh tournament and validation');
  }
}

function emptyStats(): Game['stats'][string] {
  return { decisions: 0, avgDecisionMs: 0, invalid: 0, toolCalls: 0, resumes: 0, reasonsGiven: 0, timedDecisions: 0, latencyKind: 'response' };
}

export async function archiveAttempt(dir: string, game: Game): Promise<string> {
  if (await realpath(dir) !== resolve(dir)) throw new Error('Unsafe tournament directory');
  const gamesDir = join(dir, 'games');
  await mkdir(gamesDir, { recursive: true });
  if (await realpath(gamesDir) !== resolve(gamesDir)) throw new Error('Unsafe games directory');
  const gameDir = join(dir, 'games', game.id);
  try {
    const stat = await lstat(gameDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(gameDir) !== resolve(gameDir)) throw new Error('Game attempt path is not a regular directory');
    const archive = join(dir, 'attempts', game.id);
    for (const path of [join(dir, 'attempts'), archive]) {
      await mkdir(path, { recursive: true });
      if (await realpath(path) !== resolve(path)) throw new Error('Unsafe archive directory');
    }
    let attempt = game.attempt || 1;
    for (;;) {
      try { await lstat(join(archive, String(attempt))); attempt++; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
    }
    atomicWrite(join(gameDir, 'attempt.json'), game);
    await rename(gameDir, join(archive, String(attempt)));
    game.attempt = attempt + 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    game.attempt ??= 1;
  }
  await mkdir(gameDir, { recursive: true });
  return gameDir;
}

async function playGame(tournament: Tournament, game: Game, dir: string, options: RunnerOptions, persist: () => Promise<void>, signal: AbortSignal): Promise<void> {
  const gameDir = await archiveAttempt(dir, game);
  game.status = 'running'; game.startedAt = new Date().toISOString();
  game.winner = null; game.decks = {}; game.stats = Object.fromEntries(game.seats.map(id => [id, emptyStats()]));
  game.models = {};
  game.efforts = {};
  delete game.error; delete game.endedAt; delete game.reason; delete game.turns;
  await persist();
  let bridge: Awaited<ReturnType<typeof createTournamentMcpServer>> | undefined;
  const agents = new AbortController();
  const stop = () => agents.abort();
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const tasks: Promise<void>[] = [];
  try {
    const customDecks = (tournament.deckPolicy ?? tournament.audit?.deckPolicy ?? 'choice') === 'custom-only';
    bridge = await createTournamentMcpServer({ game, gameDir, server: options.server, onChange: persist, deckPolicy: customDecks ? 'custom-only' : 'choice' });
    const current = bridge;
    const exhausted = new Set<string>();
    const deadline = options.maxMinutes === 0 ? Infinity : Date.now() + options.maxMinutes * 60_000;
    const ended = () => game.status !== 'running' || [...current.sessions.values()].some(session => session.client.ended !== null);
    for (const id of game.seats) {
      const player = tournament.players.find(p => p.id === id)!;
      tasks.push(runAgent({ player, gameDir, url: current.urlFor(id), authorization: current.authorizationFor(id), prompt: agentPrompt(tournament, game, player), signal: agents.signal, customDecks,
        onRedactor: redact => current.registerRedactor(redact),
        onModel: model => {
          game.models![id] = model;
          if (!modelMatches(player, model)) { game.error = `${id}: CLI reported an unexpected model`; game.status = 'error'; }
        },
        onEffort: effort => {
          game.efforts![id] = effort;
          if (player.effort && player.effort !== 'default' && effort !== player.effort) { game.error = `${id}: CLI lowered the requested thinking level`; game.status = 'error'; }
        },
        isEnded: ended, onResume: async () => { game.stats[id]!.resumes++; await persist(); },
      }).then(() => { if (!agents.signal.aborted && !ended()) exhausted.add(id); }, error => {
        game.error = `${id}: isolated agent failed; inspect private diagnostics`; game.status = 'error';
      }));
    }
    while (!signal.aborted) {
      if (game.error) break;
      const result = [...current.sessions.values()].find(session => session.client.ended)?.client.ended;
      game.turns = Math.max(0, ...[...current.sessions.values()].map(session => session.client.state?.turn ?? 0));
      if (result) {
        if (['room closed', 'infrastructure-error'].includes(result.reason)) throw new Error('Game server closed the duel without a verified result');
        game.winner = result.winner === null ? null : game.seats[result.winner]; game.reason = result.reason; game.status = 'done'; break;
      }
      if ([...current.sessions.values()].some(session => session.client.room && !session.client.connected)) throw new Error('Game server connection interrupted');
      if (Date.now() >= deadline || exhausted.size) {
        if (game.seats.some(id => !game.decks[id])) throw new Error('Both agents must enter the match before a result can be scored');
        const loser = exhausted.values().next().value as string | undefined;
        const adjudicated = await current.adjudicate(exhausted.size > 1 ? null : loser ? game.seats.find(id => id !== loser)! : null, loser ? 'agent-crash' : 'timeout');
        game.winner = adjudicated.winner === null ? null : game.seats[adjudicated.winner];
        game.reason = adjudicated.reason; game.status = 'done';
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
    if (!signal.aborted) { game.status = 'error'; game.winner = null; game.error = error instanceof Error ? error.message : 'Tournament infrastructure failure'; game.endedAt = new Date().toISOString(); }
  } finally {
    agents.abort(); signal.removeEventListener('abort', stop);
    await Promise.allSettled(tasks);
    await bridge?.close();
    await persist();
  }
}

export async function runTournament(options: RunnerOptions, signal: AbortSignal = new AbortController().signal): Promise<Tournament> {
  await mkdir(tournamentDir(), { recursive: true });
  const root = await realpath(tournamentDir());
  const id = options.resume ?? `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  if (await realpath(dir) !== resolve(dir)) throw new Error('Unsafe tournament directory');
  const releaseRunner = await acquireLock(join(dir, '.runner-lock'));
  const seed = options.seed ?? randomInt(0x100000000);
  let tournament: Tournament;
  try {
    tournament = options.resume
      ? JSON.parse(await readFile(join(dir, 'tournament.json'), 'utf8')) as Tournament
      : { id, name: options.validate ? `${options.name} (unscored validation)` : options.name, createdAt: new Date().toISOString(), status: 'running', format: options.bestOf ? 'best-of-three' : 'round-robin+final',
        players: options.players.map(id => ({ ...getRosterPlayer(id)! })), games: options.bestOf ? [1, 2].map(round => seriesGame(options.players as [string, string], round, seed)) : roundRobin(options.players, { cycles: options.cycles, mirrored: options.mirrored, seed }),
        ...(options.bestOf ? { series: seriesResult(options.players, [], seed) } : {}),
        scored: !options.validate, deckPolicy: options.audit?.deckPolicy ?? requestedDeckPolicy(options), ...(options.audit ? { audit: options.audit } : {}) };
    if (tournament.id !== id) throw new Error('Tournament ID does not match directory');
    if (options.resume) assertResumeDeckPolicy(options, tournament);
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
        if (tournament.series) tournament.series = seriesResult(tournament.players.map(player => player.id), tournament.games, tournament.series.seed);
        await atomicWrite(join(dir, 'tournament.json'), tournament);
        const releaseLeaderboard = await acquireLock(join(root, '.leaderboard-lock'), 10_000);
        try { atomicWrite(join(dirname(root), 'leaderboard.json'), computeLeaderboard(readTournaments(root).filter(tournament => tournament.scored === true))); }
        finally { await releaseLeaderboard(); }
      });
      return writes;
    };
    await persist();
    console.log(`Tournament ${id}: ${tournament.players.length} players, ${tournament.games.length} games (${dir})`);
    const active = new Map<Game, Promise<void>>();
    const stopOnError = new AbortController();
    const runSignal = AbortSignal.any([signal, stopOnError.signal]);
    const busy = new Set<string>();
    let launched = 0;
    while (!runSignal.aborted) {
      if (tournament.series) {
        const result = seriesResult(tournament.players.map(player => player.id), tournament.games, tournament.series.seed);
        if (result.complete) break;
        if (tournament.games.length === 2 && tournament.games.every(game => game.status === 'done')) {
          tournament.games.push(seriesGame(tournament.players.map(player => player.id) as [string, string], 3, result.seed));
          await persist();
        }
      }
      const rr = tournament.games.filter(g => g.stage === 'round-robin');
      if (!tournament.series && !options.noFinal && rr.every(g => g.status === 'done') && !tournament.games.some(g => g.stage === 'final')) {
        const top = computeStandings({ ...tournament, games: rr }).slice(0, 2);
        tournament.games.push(finalGame([top[0]!.id, top[1]!.id], Math.max(...rr.map(g => g.round)) + 1, randomInt(0x100000000)));
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
        const task = playGame(tournament, game, dir, options, persist, runSignal).finally(() => {
          if (game.status === 'error') stopOnError.abort();
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
    if (tournament.scored === false) tournament.validation = validationResult(tournament);
    await persist();
    return tournament;
  } finally { await releaseRunner(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const options = parseOptions(process.argv.slice(2));
    const prior = options.resume ? JSON.parse(await readFile(join(tournamentDir(), options.resume, 'tournament.json'), 'utf8')) as Tournament : undefined;
    if (prior && options.validate && prior.scored !== false) throw new Error('--validate cannot resume a scored or historical tournament; start a separate validation run');
    if (prior?.scored === false) { options.validate = true; options.noFinal = true; }
    if (prior) assertResumeDeckPolicy(options, prior);
    const players = prior?.players ?? options.players.map(id => getRosterPlayer(id)!);
    const audit = await preflight(options.server, players, controller.signal);
    if (prior?.audit && (prior.audit.sourceHash !== audit.sourceHash || prior.audit.server !== audit.server || prior.audit.node !== audit.node
      || prior.audit.decisionTimeoutMs !== audit.decisionTimeoutMs || prior.audit.maxInvalid !== audit.maxInvalid
      || prior.audit.maxMinutes !== undefined && prior.audit.maxMinutes !== options.maxMinutes
      || players.some(player => prior.audit?.cliVersions[player.cli] !== audit.cliVersions[player.cli]))) throw new Error('Tournament code or runtime changed; start a new validated tournament rather than mixing revisions');
    options.seed ??= randomInt(0x100000000);
    const policy = prior ? storedDeckPolicy(prior) : requestedDeckPolicy(options);
    options.audit = { ...audit, seed: options.seed, cycles: options.cycles || 1, mirrored: !!options.mirrored, maxMinutes: options.maxMinutes, validatedBy: options.validatedBy, deckPolicy: policy };
    const scheduled = prior ? prior.games.length : options.bestOf ? 3 : roundRobin(players.map(player => player.id), options).length;
    console.log(`Preflight passed: ${players.length} players, ${scheduled} scheduled games${options.games ? `, launch limit ${options.games}` : ''}${options.validate ? ' (unscored validation)' : ''}`);
    if (!options.preflightOnly) {
      if (prior?.scored !== false && !options.validate) requireValidation(options.validatedBy ?? prior?.audit?.validatedBy, players, options.audit);
      const tournament = await runTournament(options, controller.signal);
      if (tournament.games.some(game => game.status === 'error') || tournament.scored === false && !tournament.validation?.passed) process.exitCode = 1;
      if (tournament.scored === false) console.log(tournament.validation?.passed ? 'Validation passed for every roster entry' : `Validation incomplete: ${tournament.validation?.missingPlayers.join(', ')}`);
    }
    if (controller.signal.aborted) process.exitCode = 130;
  }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
