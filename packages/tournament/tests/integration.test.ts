import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../../server/src/server.js';
import { MockDuel } from '../../server/src/mock.js';
import { createTournamentMcpServer } from '../src/mcp-server.js';
import type { Game } from '../src/types.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(timeoutMs = 5000, failEngine = false) {
  const root = await mkdtemp(join(tmpdir(), 'tournament-wire-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const createDuel = vi.fn(async (options: Parameters<import('../../server/src/room.js').CreateDuel>[0]) => {
    if (failEngine) throw new Error('Fixture engine unavailable');
    return new MockDuel(options.decks, options.seed);
  });
  const server = await startServer({ port: 0, engine: null, createDuel, turnTimeoutMs: timeoutMs, botDelayMs: 0, tournamentDir: root });
  cleanup.push(() => server.close());
  const game: Game = { id: 'g1', stage: 'round-robin', round: 1, seats: ['a', 'b'], status: 'running', winner: null, decks: {}, stats: {}, seed: 4242 };
  const gameDir = join(root, 'games', 'g1');
  const bridge = await createTournamentMcpServer({ game, gameDir, server: `ws://127.0.0.1:${server.port}` });
  cleanup.push(() => bridge.close());
  const clients = new Map<string, Client>();
  for (const id of game.seats) {
    const client = new Client({ name: `fixture-${id}`, version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.urlFor(id)), { requestInit: { headers: { Authorization: bridge.authorizationFor(id) } } }));
    clients.set(id, client); cleanup.push(() => client.close());
  }
  const enter = () => Promise.all(game.seats.map(id => clients.get(id)!.callTool({ name: 'enter_match', arguments: { main: Array.from({ length: 40 }, (_, i) => 1000000 + i), reason: 'Private fixture choice' } })));
  const frames = async () => (await readFile(join(gameDir, 'replay.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { game, gameDir, bridge, clients, createDuel, enter, frames };
}

describe('real tournament MCP and WebSocket boundaries', () => {
  it('rejects cross-player credentials on a real HTTP transport', async () => {
    const { bridge, clients } = await setup();
    const response = await fetch(bridge.urlFor('b'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: bridge.authorizationFor('a') }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    expect(response.status).toBe(403);
    expect((await clients.get('a')!.listTools()).tools.map(tool => tool.name)).toContain('act');
  });
  it('records the same authenticated timeout draw in sessions and spectator replay', async () => {
    const { bridge, enter, frames, createDuel } = await setup();
    await enter();
    await bridge.sessions.get('a')!.client.waitForTurn(1000);
    expect(createDuel).toHaveBeenCalledWith(expect.objectContaining({ seed: 4242 }));
    const client = bridge.sessions.get('a')!.client;
    const denied = client.next(message => message.type === 'error' && message.message === 'tournament adjudication denied', 1000);
    client.send({ type: 'adjudicate', controlToken: '0'.repeat(64), winner: 1, reason: 'timeout' });
    await expect(denied).rejects.toThrow('tournament adjudication denied');
    expect(client.ended).toBeNull();
    const result = await bridge.adjudicate(null, 'timeout');
    expect(result).toEqual({ winner: null, reason: 'timeout' });
    await bridge.close();
    const wins = (await frames()).flatMap(frame => frame.msg.events || []).filter(event => event.t === 'win');
    expect(wins).toEqual([{ t: 'win', winner: null, reason: 'timeout' }]);
    expect(JSON.stringify(await frames())).not.toContain('Private fixture choice');
  });
  it('forfeits an expired decision without silently selecting an action', async () => {
    const { bridge, enter, frames } = await setup(100);
    await enter();
    await bridge.sessions.get('b')!.client.next(message => message.type === 'events' && message.events.some(event => event.t === 'win'), 2000);
    expect(bridge.sessions.get('b')!.client.ended).toEqual({ winner: 1, reason: 'decision-timeout' });
    await bridge.close();
    expect((await frames()).flatMap(frame => frame.msg.events || []).filter(event => event.t === 'win')).toEqual([{ t: 'win', winner: 1, reason: 'decision-timeout' }]);
  });
  it('marks a failed engine as infrastructure failure rather than a scored draw', async () => {
    const { bridge, enter } = await setup(5000, true);
    await enter();
    const client = bridge.sessions.get('a')!.client;
    if (!client.ended) await client.next(message => message.type === 'room' && message.status === 'done', 2000);
    expect(client.ended).toEqual({ winner: null, reason: 'infrastructure-error' });
  });
  it('completes a scripted duel through real SDK tools and captures response timings', async () => {
    const { bridge, clients, enter, game, frames } = await setup();
    await enter();
    for (let step = 0; step < 20; step++) {
      const id = step % 2 ? 'b' : 'a';
      await clients.get(id)!.callTool({ name: 'wait_for_turn', arguments: { timeoutSec: 2 } });
      const result = await clients.get(id)!.callTool({ name: 'act', arguments: { choose: [1], reason: 'End this fixture turn', wait: false } });
      expect(result.isError).not.toBe(true);
    }
    const client = bridge.sessions.get('a')!.client;
    if (!client.ended) await client.next(message => message.type === 'events' && message.events.some(event => event.t === 'win'), 2000);
    expect(client.ended).toEqual({ winner: null, reason: 'turn limit' });
    expect(game.stats.a).toMatchObject({ decisions: 10, timedDecisions: 10, latencyKind: 'response' });
    expect(game.stats.b).toMatchObject({ decisions: 10, timedDecisions: 10, latencyKind: 'response' });
    await bridge.close();
    expect((await frames()).flatMap(frame => frame.msg.events || []).filter(event => event.t === 'win')).toHaveLength(1);
  }, 15000);
});
