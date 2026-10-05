import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sandboxCommand } from './sandbox.js';
import { getTournament } from './storage.js';
import type { Player, Tournament } from './types.js';

const exec = promisify(execFile);

export async function preflight(server: string, players: Player[], signal?: AbortSignal): Promise<Pick<NonNullable<Tournament['audit']>, 'revision' | 'dirty' | 'sourceHash' | 'node' | 'cliVersions' | 'server' | 'decisionTimeoutMs' | 'maxInvalid'>> {
  const url = new URL(server);
  url.protocol = url.protocol === 'wss:' || url.protocol === 'https:' ? 'https:' : 'http:';
  url.pathname = url.pathname.replace(/\/ws\/?$/, '').replace(/\/$/, '');
  const base = url.toString().replace(/\/$/, '');
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  const [ready, capabilities] = await Promise.all(['ready', 'tournament-capabilities'].map(async path => {
    const response = await fetch(`${base}/api/${path}`, { signal: requestSignal });
    if (!response.ok) throw new Error('Game server is not ready for hardened tournaments; restart the updated server');
    return response.json();
  }));
  if (!ready.ready || capabilities.version !== 1 || !capabilities.adjudication || capabilities.decisionPolicy !== 'forfeit' || !capabilities.seededGames
    || !Number.isSafeInteger(capabilities.decisionTimeoutMs) || capabilities.decisionTimeoutMs <= 0 || capabilities.decisionTimeoutMs > 2147483647
    || !Number.isSafeInteger(capabilities.maxInvalid) || capabilities.maxInvalid <= 0) {
    throw new Error('Game server does not support the required tournament controls');
  }
  const cliVersions: Record<string, string> = {};
  for (const cli of new Set(players.map(player => player.cli))) {
    const dir = await mkdtemp(join(tmpdir(), 'ygosim-preflight-'));
    let isolated: Awaited<ReturnType<typeof sandboxCommand>> | undefined;
    try {
      isolated = await sandboxCommand({ command: cli, args: ['--version'], env: { PATH: process.env.PATH, HOME: process.env.HOME } }, dir, players.find(player => player.cli === cli)!, { cloneCredentials: false });
      const { stdout } = await exec(isolated.command, isolated.args, { cwd: dir, env: isolated.env, timeout: 20_000, signal });
      const version = stdout.match(/\d+\.\d+\.\d+/)?.[0];
      if (!version) throw new Error('version unavailable');
      cliVersions[cli] = version;
    } catch {
      throw new Error(`Isolated ${cli} preflight failed; check the CLI installation and bubblewrap`);
    } finally {
      await isolated?.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  }
  const root = (await exec('git', ['rev-parse', '--show-toplevel'])).stdout.trim();
  const [revision, status, files] = await Promise.all([
    exec('git', ['rev-parse', 'HEAD']), exec('git', ['status', '--porcelain']),
    exec('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z']),
  ]);
  const hash = createHash('sha256');
  for (const file of [...new Set(files.stdout.split('\0').filter(file => /^(packages|apps|docs)\//.test(file) || /^(pnpm-lock\.yaml|package\.json|tsconfig.*\.json)$/.test(file)))].sort()) {
    hash.update(file);
    try { hash.update(await readFile(join(root, file))); } catch { hash.update('[missing]'); }
  }
  return { revision: revision.stdout.trim(), dirty: !!status.stdout.trim(), sourceHash: hash.digest('hex'), node: process.version, cliVersions, server,
    decisionTimeoutMs: capabilities.decisionTimeoutMs, maxInvalid: capabilities.maxInvalid };
}

export function validationResult(tournament: Tournament): NonNullable<Tournament['validation']> {
  const checked = new Set<string>();
  for (const game of tournament.games) {
    if (game.status !== 'done' || ['timeout', 'agent-crash', 'decision-timeout', 'invalid-actions', 'room closed', 'infrastructure-error', 'surrender'].includes(game.reason || '')) continue;
    for (const id of game.seats) {
      const player = tournament.players.find(player => player.id === id);
      if (player && game.decks[id] && game.stats[id]?.decisions > 0 && (game.stats[id].timedDecisions || 0) > 0
        && ((tournament.deckPolicy ?? tournament.audit?.deckPolicy) !== 'custom-only' || game.decks[id].source === 'custom')
        && (!game.models?.[id] || modelMatches(player, game.models[id]))
        && (!game.efforts?.[id] || game.efforts[id] === player.effort)
        && (player.cli !== 'pi' || player.effort !== 'max' || game.efforts?.[id] === 'max')) checked.add(id);
    }
  }
  const checkedPlayers = tournament.players.map(player => player.id).filter(id => checked.has(id));
  const missingPlayers = tournament.players.map(player => player.id).filter(id => !checked.has(id));
  return { passed: missingPlayers.length === 0 && !tournament.games.some(game => game.status === 'error'), checkedPlayers, missingPlayers };
}

export function modelMatches(player: Player, reported: string): boolean {
  const canonical = reported.replace(/-\d{8}$/, '');
  return canonical === player.model || canonical === player.model.slice(player.model.indexOf('/') + 1);
}

export function requireValidation(id: string | undefined, players: Player[], audit: Pick<NonNullable<Tournament['audit']>, 'sourceHash' | 'cliVersions' | 'server' | 'node' | 'decisionTimeoutMs' | 'maxInvalid' | 'deckPolicy'>): void {
  const validation = id ? getTournament(id) : null;
  if (!validation || validation.scored !== false || !validation.validation?.passed || !validation.audit
    || !validationResult(validation).passed
    || validation.audit.sourceHash !== audit.sourceHash || validation.audit.server !== audit.server || validation.audit.node !== audit.node
    || validation.audit.decisionTimeoutMs !== audit.decisionTimeoutMs || validation.audit.maxInvalid !== audit.maxInvalid
    || (validation.deckPolicy ?? validation.audit.deckPolicy ?? 'choice') !== (audit.deckPolicy ?? 'choice')
    || players.some(player => !validation.validation?.checkedPlayers.includes(player.id)
      || !validation.players.some(prior => prior.id === player.id && prior.cli === player.cli && prior.model === player.model && prior.effort === player.effort)
      || validation.audit?.cliVersions[player.cli] !== audit.cliVersions[player.cli])) {
    throw new Error('A passing unscored --validate run with the same code, server, CLIs and roster is required; supply --validated-by <id>');
  }
}
