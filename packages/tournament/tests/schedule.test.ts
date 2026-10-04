import { describe, expect, it } from 'vitest';
import { roundRobin, finalGame, runnableGames } from '../src/schedule.js';
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
  it('constructs final and blocks occupied players', () => {
    expect(finalGame(['a', 'b'], 4)).toMatchObject({ stage: 'final', round: 4, seats: ['a', 'b'], status: 'pending' });
    expect(runnableGames(roundRobin(['a', 'b', 'c']), new Set(['a']))).toHaveLength(1);
  });
  it('rejects invalid roster schedules', () => {
    expect(() => roundRobin(['a'])).toThrow(); expect(() => roundRobin(['a', 'a'])).toThrow();
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
