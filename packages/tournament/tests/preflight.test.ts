import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelMatches, preflight, requireValidation, validationResult } from '../src/preflight.js';
import { atomicWrite } from '../src/storage.js';
import { ROSTER } from '../src/roster.js';
import type { Tournament } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const audit: NonNullable<Tournament['audit']> = { revision: 'fixture', dirty: true, sourceHash: 'fixture-hash', node: process.version, cliVersions: { codex: '0.160.0', claude: '2.1.289' }, server: 'ws://localhost:7777/', decisionTimeoutMs: 600000, maxInvalid: 5, seed: 42, cycles: 1, mirrored: false };
const players = [ROSTER[0]!, ROSTER.at(-1)!];

function fixture(): Tournament {
  const decks = Object.fromEntries(players.map(player => [player.id, { name: 'Fixture', source: 'custom' as const, reason: 'test', main: [1], extra: [] }]));
  const stats = Object.fromEntries(players.map(player => [player.id, { decisions: 1, timedDecisions: 1, avgDecisionMs: 10, latencyKind: 'response' as const, invalid: 0, toolCalls: 3, resumes: 0, reasonsGiven: 1 }]));
  return { id: 'validation', name: 'Fixture', scored: false, createdAt: '2026-01-01', status: 'done', format: 'round-robin+final', players,
    audit: { ...audit }, games: [{ id: 'g1', stage: 'round-robin', round: 1, seats: [players[0].id, players[1].id], status: 'done', winner: players[0].id, reason: 'lp', decks, stats }] };
}

describe('validation launch gates', () => {
  it('requires every player to complete a timed decision in a naturally finished game', () => {
    const t = fixture();
    expect(validationResult(t)).toEqual({ passed: true, checkedPlayers: players.map(player => player.id), missingPlayers: [] });
    for (const reason of ['timeout', 'agent-crash', 'decision-timeout', 'invalid-actions', 'surrender', 'infrastructure-error']) {
      t.games[0].reason = reason;
      expect(validationResult(t).passed).toBe(false);
    }
    t.games[0].reason = 'lp'; t.games[0].stats[players[0].id].timedDecisions = 0;
    expect(validationResult(t).missingPlayers).toEqual([players[0].id]);
  });
  it('requires matching code, server, model, effort and CLI version before scoring', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tournament-gate-')); roots.push(root);
    vi.stubEnv('YGOSIM_TOURNAMENT_DIR', root);
    const t = fixture(); t.validation = validationResult(t);
    atomicWrite(join(root, t.id, 'tournament.json'), t);
    expect(() => requireValidation(t.id, players, audit)).not.toThrow();
    expect(() => requireValidation(undefined, players, audit)).toThrow('passing unscored');
    expect(() => requireValidation(t.id, players, { ...audit, sourceHash: 'new-code' })).toThrow();
    expect(() => requireValidation(t.id, players, { ...audit, server: 'ws://different' })).toThrow();
    expect(() => requireValidation(t.id, players, { ...audit, decisionTimeoutMs: 1000 })).toThrow();
    expect(() => requireValidation(t.id, players, { ...audit, maxInvalid: 1 })).toThrow();
    expect(() => requireValidation(t.id, players, { ...audit, deckPolicy: 'custom-only' })).toThrow();
    expect(() => requireValidation(t.id, [{ ...players[0], model: 'different' }], audit)).toThrow();
    expect(() => requireValidation(t.id, [{ ...players[0], effort: 'max' }], audit)).toThrow();
    expect(() => requireValidation(t.id, players, { ...audit, cliVersions: { codex: 'different', claude: '2.1.289' } })).toThrow();
    t.scored = true; atomicWrite(join(root, t.id, 'tournament.json'), t);
    expect(() => requireValidation(t.id, players, audit)).toThrow();
  });
  it('refuses validation for a reported fallback model and for infrastructure errors', () => {
    const t = fixture();
    t.games[0].models = { [players[1].id]: 'different-model' };
    expect(validationResult(t).missingPlayers).toEqual([players[1].id]);
    t.games[0].models[players[1].id] = `${players[1].model}-20261005`;
    expect(validationResult(t).passed).toBe(true);
    t.games.push({ ...t.games[0], id: 'g2', status: 'error' });
    expect(validationResult(t).passed).toBe(false);
    expect(modelMatches(ROSTER[2]!, 'grok-4.6')).toBe(true);
    expect(modelMatches(ROSTER[2]!, 'grok-4.7')).toBe(false);
  });
  it('rejects an outdated game server before checking or starting agents', async () => {
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try { await expect(preflight(`http://127.0.0.1:${port}`, players)).rejects.toThrow('restart the updated server'); }
    finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  });
  it('hashes repository source after server capability checks without provider calls', async () => {
    const server = createServer((req, res) => {
      if (!['/api/ready', '/api/tournament-capabilities'].includes(req.url || '')) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url?.endsWith('/ready') ? { ready: true } : { version: 1, adjudication: true, decisionPolicy: 'forfeit', seededGames: true, decisionTimeoutMs: 600000, maxInvalid: 5 }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await preflight(`http://127.0.0.1:${port}`, []);
      expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.revision).toMatch(/^[a-f0-9]{40}$/);
      expect(result.cliVersions).toEqual({});
    } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  }, 15000);
});
