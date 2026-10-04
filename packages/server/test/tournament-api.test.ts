import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTournamentApi } from "../src/tournament-api.js";
import { buildApi } from "../src/server.js";
import { Lobby } from "../src/lobby.js";
import { atomicWrite } from "@ygosim/tournament/storage";
import type { Tournament } from "@ygosim/tournament/types";

function fixture(): Tournament {
  return {
    id: "cup-1",
    name: "Cup 1",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "done",
    format: "round-robin+final",
    players: [
      { id: "p1", label: "One", cli: "codex", model: "m1" },
      { id: "p2", label: "Two", cli: "pi", model: "m2" },
    ],
    games: [{
      id: "g1", stage: "round-robin", round: 1, seats: ["p1", "p2"], status: "done", winner: "p1",
      endedAt: "2026-01-01T00:01:00.000Z",
      decks: {
        p1: { name: "Alpha", source: "sample", reason: "r", main: [], extra: [] },
        p2: { name: "Beta", source: "custom", reason: "r", main: [], extra: [] },
      },
      stats: {
        p1: { decisions: 2, avgDecisionMs: 10, invalid: 0, toolCalls: 2, resumes: 0, reasonsGiven: 2 },
        p2: { decisions: 1, avgDecisionMs: 20, invalid: 1, toolCalls: 1, resumes: 0, reasonsGiven: 0 },
      },
    }],
  };
}

describe("tournament API", () => {
  it("serves summaries, detail, logs and the computed leaderboard", async () => {
    const root = mkdtempSync(join(tmpdir(), "ygosim-tournament-api-"));
    const tournament = fixture();
    const dir = join(root, "tournaments");
    const tournamentPath = join(dir, tournament.id, "tournament.json");
    atomicWrite(tournamentPath, tournament);
    mkdirSync(join(dir, tournament.id, "games", "g1"), { recursive: true });
    writeFileSync(join(dir, tournament.id, "games", "g1", "replay.jsonl"), '{"t":1,"msg":{"type":"duel"}}\n');
    writeFileSync(join(dir, tournament.id, "games", "g1", "p1.decisions.jsonl"), '{"t":2,"reason":"play"}\n');

    const app = buildApi(new Lobby(async () => { throw new Error("unused"); }), () => null, () => null, async () => null, undefined, undefined, dir);
    const list = await app.request("/api/tournaments");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([{
      id: "cup-1", name: "Cup 1", createdAt: "2026-01-01T00:00:00.000Z", status: "done",
      players: tournament.players, done: 1, total: 1,
    }]);

    const detail = await app.request("/api/tournaments/cup-1");
    expect(detail.status).toBe(200);
    expect((await detail.json()).standings[0]).toMatchObject({ id: "p1", wins: 1, points: 3 });
    expect(await (await app.request("/api/tournaments/cup-1/games/g1/replay")).json()).toEqual([{ t: 1, msg: { type: "duel" } }]);
    expect(await (await app.request("/api/tournaments/cup-1/games/g1/decisions/p1")).json()).toEqual([{ t: 2, reason: "play" }]);
    expect((await (await app.request("/api/leaderboard")).json()).players[0]).toMatchObject({ id: "p1", points: 3 });
  });

  it("rejects traversal and symlink escapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ygosim-tournament-api-"));
    const dir = join(root, "tournaments");
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "tournament.json"), JSON.stringify(fixture()));
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, "linked"), "dir");

    const app = buildTournamentApi(dir);
    expect([400, 404]).toContain((await app.request("/api/tournaments/%2e%2e")).status);
    expect((await app.request("/api/tournaments/cup-1/games/g1/decisions/bad.player")).status).toBe(400);
    expect((await app.request("/api/tournaments/linked")).status).toBe(404);
    expect((await app.request("/api/tournaments/linked/games/g1/replay")).status).toBe(404);
  });
});
