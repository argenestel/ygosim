import { describe, expect, it } from 'vitest';
import { roundRobin, makeGame, finalGame, runnableGames, seriesGame, seriesResult } from '../src/schedule.js';

it('alternates reproducibly seeded best-of-three games and caps the series at three', () => {
  const players: [string, string] = ['a', 'b'];
  const games = [1, 2, 3].map(round => seriesGame(players, round, 42));
  expect(games.map(game => game.seats)).toEqual([['a', 'b'], ['b', 'a'], ['a', 'b']]);
  expect(new Set(games.map(game => game.seed)).size).toBe(3);
  expect(seriesGame(players, 2, 42)).toEqual(games[1]);
  expect(() => seriesGame(players, 4, 42)).toThrow();
  const draws = games.map(game => ({ ...game, status: 'done' as const, winner: null }));
  expect(seriesResult(players, draws, 42)).toMatchObject({ complete: true, winner: null, wins: { a: 0, b: 0 } });
});
import { agentCommand } from '../src/agent-process.js';
import { ROSTER } from '../src/roster.js';
describe('schedule', () => {
  for (const n of [2, 3, 4, 5, 6, 7]) it(`covers all pairs once, balanced seats and disjoint rounds for ${n}`, () => {
    const players = Array.from({ length: n }, (_, i) => `p${i}`);
    const games = roundRobin(players);
    expect(games).toHaveLength(n * (n - 1) / 2);
    expect(new Set(games.map(g => [...g.seats].sort().join(','))).size).toBe(games.length);
    for (const player of players) {
      const first = games.filter(g => g.seats[0] === player).length;
      const second = games.filter(g => g.seats[1] === player).length;
      expect(Math.abs(first - second)).toBeLessThanOrEqual(1);
    }
    for (const round of new Set(games.map(g => g.round))) {
      const seats = games.filter(g => g.round === round).flatMap(g => g.seats);
      expect(new Set(seats).size).toBe(seats.length);
    }
  });
  it('preserves the default single round-robin schedule without seed metadata', () => {
    const players = ['a', 'b', 'c', 'd'];
    const games = roundRobin(players);
    expect(games.map(({ id, seats, round }) => ({ id, seats, round }))).toEqual([
      { id: 'g001', seats: ['d', 'a'], round: 1 },
      { id: 'g002', seats: ['b', 'c'], round: 1 },
      { id: 'g003', seats: ['a', 'c'], round: 2 },
      { id: 'g004', seats: ['b', 'd'], round: 2 },
      { id: 'g005', seats: ['a', 'b'], round: 3 },
      { id: 'g006', seats: ['c', 'd'], round: 3 },
    ]);
    expect(roundRobin(players, {})).toEqual(games);
    expect(roundRobin(players, { cycles: 1, mirrored: false })).toEqual(games);
    for (const game of games) {
      expect(game).not.toHaveProperty('seed');
      expect(game).not.toHaveProperty('cycle');
    }
    expect(players).toEqual(['a', 'b', 'c', 'd']);
  });
  for (const seed of [0, 1, 0xffffffff]) it(`produces deterministic unsigned seeds from ${seed} without doubling games`, () => {
    const players = ['a', 'b', 'c', 'd'];
    const games = roundRobin(players, { seed });
    expect(games).toHaveLength(6);
    expect(roundRobin(players, { seed })).toEqual(games);
    expect(roundRobin(players, { seed: (seed + 1) >>> 0 })).not.toEqual(games);
    expect(games.map(({ id, seats, round }) => ({ id, seats, round }))).toEqual(
      roundRobin(players).map(({ id, seats, round }) => ({ id, seats, round })),
    );
    expect(new Set(games.map(g => g.seed)).size).toBe(games.length);
    for (const game of games) {
      expect(Number.isInteger(game.seed)).toBe(true);
      expect(game.seed).toBeGreaterThanOrEqual(0);
      expect(game.seed).toBeLessThanOrEqual(0xffffffff);
      expect(game.cycle).toBe(1);
    }
  });
  for (const n of [2, 3, 4, 5, 6, 7]) it(`mirrors every pair with shared seeds and disjoint rounds across cycles for ${n}`, () => {
    const players = Array.from({ length: n }, (_, i) => `p${i}`);
    const options = { cycles: 2, mirrored: true, seed: 42 };
    const games = roundRobin(players, options);
    const pairCount = n * (n - 1) / 2;
    const roundsPerCycle = n % 2 ? n : n - 1;
    expect(games).toHaveLength(pairCount * options.cycles * 2);
    expect(roundRobin(players, options)).toEqual(games);
    expect(roundRobin(players, { ...options, cycles: 3 }).slice(0, games.length)).toEqual(games);
    expect(new Set(games.map(g => g.id)).size).toBe(games.length);
    expect(new Set(games.map(g => g.seed)).size).toBe(pairCount * options.cycles);
    expect([...new Set(games.map(g => g.round))]).toEqual(
      Array.from({ length: roundsPerCycle * options.cycles * 2 }, (_, i) => i + 1),
    );
    for (let cycle = 1; cycle <= options.cycles; cycle++) {
      const cycleGames = games.filter(g => g.cycle === cycle);
      const pairs = new Set(cycleGames.map(g => [...g.seats].sort().join(',')));
      expect(cycleGames).toHaveLength(pairCount * 2);
      expect(pairs.size).toBe(pairCount);
      for (const pair of pairs) {
        const matches = cycleGames.filter(g => [...g.seats].sort().join(',') === pair);
        expect(matches).toHaveLength(2);
        expect(matches[1]!.seats).toEqual([...matches[0]!.seats].reverse());
        expect(matches[1]!.seed).toBe(matches[0]!.seed);
        expect(matches[1]!.round).toBe(matches[0]!.round + roundsPerCycle);
        expect(matches[1]!.decks).not.toBe(matches[0]!.decks);
        expect(matches[1]!.stats).not.toBe(matches[0]!.stats);
      }
      for (const player of players) {
        expect(cycleGames.filter(g => g.seats[0] === player)).toHaveLength(n - 1);
        expect(cycleGames.filter(g => g.seats[1] === player)).toHaveLength(n - 1);
      }
    }
    for (const round of new Set(games.map(g => g.round))) {
      const seats = games.filter(g => g.round === round).flatMap(g => g.seats);
      expect(new Set(seats).size).toBe(seats.length);
    }
  });
  it('repeats complete unmirrored cycles with new seeds and stable rounds', () => {
    const players = ['a', 'b', 'c', 'd'];
    const games = roundRobin(players, { cycles: 3, seed: 42 });
    const baseGames = roundRobin(players);
    expect(games).toHaveLength(baseGames.length * 3);
    expect(new Set(games.map(g => g.seed)).size).toBe(games.length);
    expect(new Set(games.map(g => g.id)).size).toBe(games.length);
    for (let cycle = 1; cycle <= 3; cycle++) {
      const cycleGames = games.filter(g => g.cycle === cycle);
      expect(cycleGames.map(g => g.seats)).toEqual(baseGames.map(g => g.seats));
      expect(cycleGames.map(g => g.round)).toEqual(baseGames.map(g => g.round + (cycle - 1) * 3));
    }
    expect(roundRobin(players, { cycles: 3, seed: 42 })).toEqual(games);
  });
  it('supports opt-in mirroring and cycles without inventing seeds', () => {
    const mirrored = roundRobin(['a', 'b'], { mirrored: true });
    expect(mirrored.map(({ seats, round, cycle }) => ({ seats, round, cycle }))).toEqual([
      { seats: ['a', 'b'], round: 1, cycle: 1 },
      { seats: ['b', 'a'], round: 2, cycle: 1 },
    ]);
    const repeated = roundRobin(['a', 'b'], { cycles: 2 });
    expect(repeated.map(({ seats, round, cycle }) => ({ seats, round, cycle }))).toEqual([
      { seats: ['a', 'b'], round: 1, cycle: 1 },
      { seats: ['a', 'b'], round: 2, cycle: 2 },
    ]);
    for (const game of [...mirrored, ...repeated]) expect(game).not.toHaveProperty('seed');
  });
  it('constructs final and blocks occupied players', () => {
    expect(finalGame(['a', 'b'], 4)).toMatchObject({ stage: 'final', round: 4, seats: ['a', 'b'], status: 'pending' });
    expect(runnableGames(roundRobin(['a', 'b', 'c']), new Set(['a']))).toHaveLength(1);
  });
  it('keeps game constructors backward compatible and accepts an optional final seed', () => {
    expect(makeGame('custom', ['a', 'b'], 2)).toEqual({
      id: 'custom', seats: ['a', 'b'], round: 2, stage: 'round-robin', status: 'pending', winner: null, decks: {}, stats: {},
    });
    expect(makeGame('custom', ['a', 'b'], 2, 'final').stage).toBe('final');
    expect(finalGame(['a', 'b'], 4)).not.toHaveProperty('seed');
    expect(finalGame(['a', 'b'], 4, 0)).toMatchObject({ id: 'final', stage: 'final', round: 4, seed: 0 });
    expect(finalGame(['a', 'b'], 4, 0xffffffff).seed).toBe(0xffffffff);
  });
  it('rejects invalid roster schedules', () => {
    expect(() => roundRobin(['a'])).toThrow(); expect(() => roundRobin(['a', 'a'])).toThrow();
  });
  it('rejects cycle counts that are not positive safe integers', () => {
    for (const cycles of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, null, '2']) {
      expect(() => roundRobin(['a', 'b'], { cycles: cycles as number })).toThrow('Cycles must be a positive safe integer');
    }
  });
  it('rejects seeds outside the uint32 integer range', () => {
    for (const seed of [-1, 0x100000000, 1.5, NaN, Infinity, -Infinity, null, '2']) {
      expect(() => roundRobin(['a', 'b'], { seed: seed as number })).toThrow('Seed must be a uint32 integer');
      expect(() => finalGame(['a', 'b'], 4, seed as number)).toThrow('Seed must be a uint32 integer');
    }
  });
});
describe('CLI commands', () => {
  it('passes reasoning and MCP URL to Codex initial and resume commands', () => {
    const player = ROSTER[0]!;
    expect(agentCommand(player, 'http://localhost/mcp', '/tmp/game', 'play', '', false).args).toContain('mcp_servers.ygosim.tool_timeout_sec=660');
    expect(agentCommand(player, 'http://localhost/mcp', '/tmp/game', 'continue', 'thread', true).args.slice(0, 3)).toEqual(['exec', 'resume', 'thread']);
  });
  it('continues pi and Claude sessions', () => {
    expect(agentCommand(ROSTER[2]!, 'url', '/tmp/game', 'play', '', true).args).toContain('--continue');
    const claude = agentCommand(ROSTER[6]!, 'url', '/tmp/game', 'play', 'uuid', true);
    expect(claude.args).toContain('--resume'); expect(claude.env.MCP_TOOL_TIMEOUT).toBe('660000');
  });
});
