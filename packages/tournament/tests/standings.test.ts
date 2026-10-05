import { describe, it, expect } from "vitest";
import { updateElo, computeLeaderboard, computeStandings } from "../src/standings";
import type { Tournament } from "../src/types";

describe("Elo calculations", () => {
  it('returns one rating for numeric scores and string results', () => {
    expect(updateElo(1500, 1500, 1)).toBe(1516);
    expect(updateElo(1500, 1500, 0)).toBe(1484);
    expect(updateElo(1500, 1500, 0.5)).toBe(1500);
    expect(updateElo(1600, 1484, 'loss')).toBe(updateElo(1600, 1484, 0));
  });
  it("should increase elo on win", () => {
    const newElo = updateElo(1500, 1500, "win");
    expect(newElo).toBeGreaterThan(1500);
  });

  it("should decrease elo on loss", () => {
    const newElo = updateElo(1500, 1500, "loss");
    expect(newElo).toBeLessThan(1500);
  });

  it("should not change elo on draw against equal opponent", () => {
    const newElo = updateElo(1500, 1500, "draw");
    expect(newElo).toBe(1500);
  });

  it("should apply K-factor correctly", () => {
    const strongWin = updateElo(1500, 1400, "win");
    const weakWin = updateElo(1500, 1600, "win");
    // Winning against a weaker opponent gives less elo than winning against a stronger opponent
    expect(strongWin).toBeLessThan(weakWin);
  });
});

describe("Standings computation", () => {
  it("should compute standings from tournament", () => {
    const tournament: Tournament = {
      id: "test-1",
      name: "Test Tournament",
      createdAt: new Date().toISOString(),
      status: "done",
      format: "round-robin+final",
      players: [
        { id: "p1", label: "Player 1", cli: "codex", model: "test-model" },
        { id: "p2", label: "Player 2", cli: "pi", model: "test-model" },
      ],
      games: [
        {
          id: "g1",
          stage: "round-robin",
          round: 1,
          seats: ["p1", "p2"],
          status: "done",
          winner: "p1",
          endedAt: new Date().toISOString(),
          decks: {
            p1: { name: "Deck A", source: "sample", reason: "test", main: [], extra: [] },
            p2: { name: "Deck B", source: "sample", reason: "test", main: [], extra: [] },
          },
          stats: {
            p1: { decisions: 10, avgDecisionMs: 100, invalid: 0, toolCalls: 10, resumes: 0, reasonsGiven: 10 },
            p2: { decisions: 10, avgDecisionMs: 100, invalid: 1, toolCalls: 10, resumes: 0, reasonsGiven: 8 },
          },
        },
      ],
    };

    const standings = computeStandings(tournament);
    expect(standings).toHaveLength(2);
    expect(standings[0].id).toBe("p1");
    expect(standings[0].wins).toBe(1);
    expect(standings[0].points).toBe(3);
    expect(standings[1].id).toBe("p2");
    expect(standings[1].losses).toBe(1);
    expect(standings[1].points).toBe(0);
  });

  it("should handle draws correctly", () => {
    const tournament: Tournament = {
      id: "test-2",
      name: "Test Tournament",
      createdAt: new Date().toISOString(),
      status: "done",
      format: "round-robin+final",
      players: [
        { id: "p1", label: "Player 1", cli: "codex", model: "test-model" },
        { id: "p2", label: "Player 2", cli: "pi", model: "test-model" },
      ],
      games: [
        {
          id: "g1",
          stage: "round-robin",
          round: 1,
          seats: ["p1", "p2"],
          status: "done",
          winner: null,
          endedAt: new Date().toISOString(),
          decks: {
            p1: { name: "Deck A", source: "sample", reason: "test", main: [], extra: [] },
            p2: { name: "Deck B", source: "sample", reason: "test", main: [], extra: [] },
          },
          stats: {
            p1: { decisions: 10, avgDecisionMs: 100, invalid: 0, toolCalls: 10, resumes: 0, reasonsGiven: 10 },
            p2: { decisions: 10, avgDecisionMs: 100, invalid: 0, toolCalls: 10, resumes: 0, reasonsGiven: 10 },
          },
        },
      ],
    };

    const standings = computeStandings(tournament);
    expect(standings[0].draws).toBe(1);
    expect(standings[0].points).toBe(1);
    expect(standings[1].draws).toBe(1);
    expect(standings[1].points).toBe(1);
  });

  it("applies Elo by endedAt and weights decision metrics by decision count", () => {
    const base = {
      id: "p1", label: "Player 1", cli: "codex" as const, model: "m1",
    };
    const tournament: Tournament = {
      id: "ordered",
      name: "Ordered",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "done",
      format: "round-robin+final",
      players: [base, { ...base, id: "p2", label: "Player 2", cli: "pi" }],
      games: [
        {
          id: "later", stage: "round-robin", round: 1, seats: ["p1", "p2"], status: "done", winner: "p1",
          endedAt: "2026-01-01T00:02:00.000Z", turns: 4,
          decks: { p1: { name: "Alpha", source: "sample", reason: "", main: [], extra: [] }, p2: { name: "Beta", source: "sample", reason: "", main: [], extra: [] } },
          stats: { p1: { decisions: 8, avgDecisionMs: 30, invalid: 1, toolCalls: 8, resumes: 0, reasonsGiven: 4 }, p2: { decisions: 8, avgDecisionMs: 10, invalid: 0, toolCalls: 8, resumes: 0, reasonsGiven: 8 } },
        },
        {
          id: "earlier", stage: "round-robin", round: 1, seats: ["p1", "p2"], status: "done", winner: "p2",
          endedAt: "2026-01-01T00:01:00.000Z", turns: 2,
          decks: { p1: { name: "Alpha", source: "sample", reason: "", main: [], extra: [] }, p2: { name: "Beta", source: "sample", reason: "", main: [], extra: [] } },
          stats: { p1: { decisions: 2, avgDecisionMs: 10, invalid: 0, toolCalls: 2, resumes: 0, reasonsGiven: 2 }, p2: { decisions: 2, avgDecisionMs: 30, invalid: 0, toolCalls: 2, resumes: 0, reasonsGiven: 2 } },
        },
      ],
    };

    const standings = computeStandings(tournament);
    const p1 = standings.find(player => player.id === "p1")!;
    expect(p1.elo).toBeCloseTo(1501.4695015289756);
    expect(p1.avgTurns).toBe(3);
    expect(p1.avgDecisionMs).toBe(26);
    expect(p1.invalidRate).toBe(0.1);
    expect(p1.reasonRate).toBe(0.6);
    expect(p1.decks).toEqual([{ name: "Alpha", played: 2, wins: 1 }]);
  });

  it("weights metrics and preserves deck sources across tournaments", () => {
    const game = (id: string, endedAt: string, source: "sample" | "custom", decisions: number, avgDecisionMs: number): Tournament["games"][number] => ({
      id, stage: "round-robin", round: 1, seats: ["p1", "p2"], status: "done", winner: "p1", endedAt,
      decks: {
        p1: { name: "Same", source, reason: "", main: [], extra: [] },
        p2: { name: "Other", source: "sample", reason: "", main: [], extra: [] },
      },
      stats: {
        p1: { decisions, avgDecisionMs, invalid: 0, toolCalls: decisions, resumes: 0, reasonsGiven: decisions },
        p2: { decisions: 0, avgDecisionMs: 0, invalid: 0, toolCalls: 0, resumes: 0, reasonsGiven: 0 },
      },
    });
    const makeTournament = (id: string, games: Tournament["games"]): Tournament => ({
      id, name: id, createdAt: "2026-01-01T00:00:00.000Z", status: "done", format: "round-robin+final",
      players: [{ id: "p1", label: "One", cli: "codex", model: "m" }, { id: "p2", label: "Two", cli: "pi", model: "m" }], games,
    });

    const leaderboard = computeLeaderboard([
      makeTournament("one", [game("g1", "2026-01-01T00:01:00.000Z", "sample", 1, 10)]),
      makeTournament("two", [game("g2", "2026-01-01T00:02:00.000Z", "custom", 3, 30)]),
    ]);
    const p1 = leaderboard.players.find(player => player.id === "p1")!;
    expect(p1.avgDecisionMs).toBe(25);
    expect(leaderboard.decks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Same", source: "sample", picks: 1, wins: 1 }),
      expect.objectContaining({ name: "Same", source: "custom", picks: 1, wins: 1 }),
    ]));
  });
});

it('breaks equal points by Elo and counts done games with optional timestamps absent', () => {
  const players = ['a', 'b', 'c'].map(id => ({ id, label: id, cli: 'codex' as const, model: 'model' }));
  const match = (id: string, seats: [string, string], winner: string): Tournament['games'][number] => ({
    id, stage: 'round-robin', round: 1, seats, status: 'done', winner, decks: {}, stats: {},
  });
  const tournament: Tournament = { id: 'tie', name: 'tie', createdAt: '2026-01-01', status: 'done', format: 'round-robin+final', players,
    games: [match('one', ['a', 'b'], 'a'), match('two', ['a', 'c'], 'c')] };
  const standings = computeStandings(tournament);
  expect(standings.map(row => row.id)).toEqual(['c', 'a', 'b']);
  expect(standings[0]!.points).toBe(standings[1]!.points);
  expect(standings[0]!.elo).toBeGreaterThan(standings[1]!.elo);
});

it('weights response latency by timed submissions rather than all decisions', () => {
  const players = ['a', 'b'].map(id => ({ id, label: id, cli: 'codex' as const, model: 'model' }));
  const games: Tournament['games'] = [10, 30].map((avgDecisionMs, index) => ({
    id: `g${index}`, stage: 'round-robin', round: 1, seats: ['a', 'b'], status: 'done', winner: 'a', decks: {},
    stats: { a: { decisions: 100, timedDecisions: index + 1, latencyKind: 'response', avgDecisionMs, invalid: 0, toolCalls: 100, resumes: 0, reasonsGiven: 100 } },
  }));
  expect(computeStandings(players, games).find(player => player.id === 'a')!.avgDecisionMs).toBeCloseTo(70 / 3);
});
