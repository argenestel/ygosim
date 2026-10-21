import { appendFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    scored: true,
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

function organizerAccess(): RequestInit {
  vi.stubEnv("YGOSIM_TOURNAMENT_READ_TOKEN", fixture().id);
  return { headers: { Authorization: `Bearer ${fixture().id}` } };
}

function seed(options: {
  tournament?: Tournament;
  replay?: string;
  decisions?: string;
  tools?: string;
  transcript?: string | Buffer;
  stderr?: string | Buffer;
  skipReplay?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "ygosim-tournament-api-"));
  const tournament = options.tournament ?? fixture();
  const dir = join(root, "tournaments");
  const gameDir = join(dir, tournament.id, "games", "g1");
  atomicWrite(join(dir, tournament.id, "tournament.json"), tournament);
  mkdirSync(gameDir, { recursive: true });
  if (!options.skipReplay) {
    writeFileSync(
      join(gameDir, "replay.jsonl"),
      options.replay ?? '{"t":1,"msg":{"type":"duel"}}\n{"t":2,"msg":{"type":"state"}}\nnot-json\n{"t":3,"msg":{"type":"end"}}\n',
    );
  }
  writeFileSync(join(gameDir, "p1.decisions.jsonl"), options.decisions ?? '{"t":2,"reason":"play"}\n');
  writeFileSync(
    join(gameDir, "p1.tools.jsonl"),
    options.tools ?? '{"t":1,"tool":"act","args":{"n":1},"ok":true,"ms":5}\nnot-json\n{"t":2,"tool":"wait","args":{},"ok":true,"ms":7}\n{"t":3,"tool":"get_state","args":{},"ok":false,"ms":1}\n',
  );
  if (options.transcript !== undefined) writeFileSync(join(gameDir, "p1.transcript.jsonl"), options.transcript);
  if (options.stderr !== undefined) writeFileSync(join(gameDir, "p1.stderr.log"), options.stderr);
  return { root, dir, tournament, gameDir, app: buildTournamentApi(dir) };
}

function writeTournament(dir: string, tournament: Tournament): void {
  atomicWrite(join(dir, tournament.id, "tournament.json"), tournament);
  for (const game of tournament.games) mkdirSync(join(dir, tournament.id, "games", game.id), { recursive: true });
}

function providerPlayers(): Tournament["players"] {
  return [
    { id: "xai-player", label: "Grok", cli: "pi", model: "xai/grok-4.7" },
    { id: "deepseek-player", label: "DeepSeek", cli: "pi", model: "fireworks/accounts/fireworks/models/deepseek-v4p1-flash" },
    { id: "zai-player", label: "GLM", cli: "pi", model: "fireworks/accounts/fireworks/models/glm-5p3-flash" },
    { id: "google-player", label: "Gemini", cli: "agy", model: "gemini-3.8-flash-high" },
    { id: "anthropic-player", label: "Claude", cli: "claude", model: "claude-opus-5-5" },
    { id: "openai-player", label: "Codex", cli: "codex", model: "gpt-6-luna" },
  ];
}

describe("tournament API", () => {
  beforeEach(() => {
    vi.stubEnv("YGOSIM_TOURNAMENT_READ_TOKEN", undefined);
    vi.stubEnv("YGOSIM_TOURNAMENT_HIDE_LIVE", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("normalizes summary kind, state, progress and provider-rich player references", async () => {
    const root = mkdtempSync(join(tmpdir(), "ygosim-tournament-summary-"));
    const dir = join(root, "tournaments");
    const makeTournament = (id: string, status: Tournament["status"], scored: boolean | undefined): Tournament => {
      const game = { ...fixture().games[0]!, id: `${id}-g1`, seats: ["xai-player", "deepseek-player"] as [string, string] };
      const tournament = { ...fixture(), id, name: id === "validation" ? "Validation Cup (unscored validation)" : id,
        status, players: providerPlayers(), games: [game] };
      if (scored === undefined) delete tournament.scored;
      else tournament.scored = scored;
      if (id === "validation") tournament.validation = { passed: true, checkedPlayers: ["xai-player"], missingPlayers: [] };
      if (id === "validation") tournament.games[0]!.status = "running";
      if (id === "legacy") tournament.games[0]!.status = "error";
      return tournament;
    };
    const scored = makeTournament("scored", "done", true);
    const validation = makeTournament("validation", "running", false);
    const legacy = makeTournament("legacy", "running", undefined);
    writeTournament(dir, scored);
    writeTournament(dir, validation);
    writeTournament(dir, legacy);
    const lock = join(dir, validation.id, ".runner-lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, `owner-${process.pid}-summary`), "");

    const rows = await (await buildTournamentApi(dir).request("/api/tournaments")).json();
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "scored", name: "scored", kind: "scored", state: "finished", active: false,
        progress: { done: 1, total: 1, live: 0, errors: 0 }, done: 1, total: 1 }),
      expect.objectContaining({ id: "validation", name: "Validation Cup", kind: "validation", state: "live", active: true,
        progress: { done: 0, total: 1, live: 1, errors: 0 }, done: 0, total: 1 }),
      expect.objectContaining({ id: "legacy", name: "legacy", kind: "legacy", state: "paused", active: false,
        progress: { done: 0, total: 1, live: 0, errors: 1 }, done: 0, total: 1 }),
    ]));

    const validationSummary = rows.find((row: { id: string }) => row.id === "validation");
    expect(validationSummary.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "xai-player", provider: "xai" }),
      expect.objectContaining({ id: "deepseek-player", provider: "deepseek", host: "Fireworks" }),
      expect.objectContaining({ id: "zai-player", provider: "zai", host: "Fireworks" }),
      expect.objectContaining({ id: "google-player", provider: "google" }),
      expect.objectContaining({ id: "anthropic-player", provider: "anthropic" }),
      expect.objectContaining({ id: "openai-player", provider: "openai" }),
    ]));
    const leaderboard = await (await buildTournamentApi(dir).request("/api/leaderboard")).json();
    expect(leaderboard.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "xai-player", provider: "xai" }),
      expect.objectContaining({ id: "deepseek-player", provider: "deepseek", host: "Fireworks" }),
    ]));
  });

  it("chooses leaders by points then Elo and exposes champions only for finished tournaments", async () => {
    const root = mkdtempSync(join(tmpdir(), "ygosim-tournament-leaders-"));
    const dir = join(root, "tournaments");
    const baseGame = fixture().games[0]!;
    const game = (id: string, seats: [string, string], winner: string | null, endedAt: string, stage: "round-robin" | "final" | "series" = "round-robin") => ({
      ...baseGame, id, stage, seats, winner, endedAt, startedAt: "2026-01-01T00:00:00.000Z", decks: {}, stats: {},
    });
    const players = [
      { id: "p1", label: "One", cli: "codex" as const, model: "gpt-6" },
      { id: "p2", label: "Two", cli: "pi" as const, model: "xai/grok" },
      { id: "p3", label: "Three", cli: "claude" as const, model: "claude-opus" },
    ];
    const leaderTournament: Tournament = {
      ...fixture(), id: "leaders", name: "Leaders", status: "done", scored: true, players,
      games: [game("g1", ["p1", "p2"], "p1", "2026-01-01T00:01:00.000Z"), game("g2", ["p2", "p3"], "p2", "2026-01-01T00:02:00.000Z")],
    };
    const finalTournament: Tournament = {
      ...fixture(), id: "final", name: "Final", status: "done", scored: true, players: players.slice(0, 2),
      games: [game("g1", ["p1", "p2"], "p1", "2026-01-01T00:01:00.000Z"), game("g2", ["p1", "p2"], "p2", "2026-01-01T00:02:00.000Z", "final")],
    };
    const seriesTournament: Tournament = {
      ...fixture(), id: "series", name: "Series", status: "done", scored: true, format: "best-of-three", players: players.slice(0, 2),
      series: { bestOf: 3, seed: 1, wins: { p1: 1, p2: 2 }, winner: "p2", complete: true },
      games: [game("g1", ["p1", "p2"], "p2", "2026-01-01T00:01:00.000Z", "series")],
    };
    const runningTournament: Tournament = {
      ...fixture(), id: "running", name: "Running", status: "running", scored: true, players: players.slice(0, 2),
      games: [game("g1", ["p1", "p2"], null, "2026-01-01T00:01:00.000Z")],
    };
    runningTournament.games[0]!.status = "running";
    const uniqueTournament: Tournament = {
      ...fixture(), id: "unique", name: "Unique", status: "done", scored: true, players: players.slice(0, 2),
      games: [game("g1", ["p1", "p2"], "p1", "2026-01-01T00:01:00.000Z")],
    };
    for (const tournament of [leaderTournament, finalTournament, seriesTournament, runningTournament, uniqueTournament]) writeTournament(dir, tournament);

    const app = buildTournamentApi(dir);
    const leaders = await (await app.request("/api/tournaments/leaders")).json();
    expect(leaders.leader).toMatchObject({ id: "p1", points: 3 });
    expect(leaders.champion).toBeNull();
    const final = await (await app.request("/api/tournaments/final")).json();
    expect(final.champion).toBe("p2");
    const series = await (await app.request("/api/tournaments/series")).json();
    expect(series.champion).toBe("p2");
    const unique = await (await app.request("/api/tournaments/unique")).json();
    expect(unique.champion).toBe("p1");
    const running = await (await app.request("/api/tournaments/running")).json();
    expect(running.leader).toBeNull();
    expect(running.champion).toBeNull();
  });

  it("returns enriched game detail with seat order, duration and concise deck titles", async () => {
    const tournament = fixture();
    tournament.audit = {
      revision: "rev", sourceHash: "hash", dirty: false, node: process.version,
      cliVersions: {}, server: "ws://localhost", decisionTimeoutMs: 1000, maxInvalid: 2,
      maxMinutes: 90, onTimeout: "lp", seed: 1, cycles: 1, mirrored: false,
    };
    const game = tournament.games[0]!;
    game.seats = ["p2", "p1"];
    game.startedAt = "2026-01-01T00:00:00.000Z";
    game.endedAt = "2026-01-01T00:01:00.000Z";
    game.decks.p1 = { name: "Custom deck deadbeef", source: "custom", reason: "Dragon control: compact extra deck", main: [], extra: [] };
    const { app } = seed({ tournament });

    const detail = await (await app.request("/api/tournaments/cup-1")).json();
    expect(detail.games[0]).toMatchObject({ durationMs: 60_000,
      decks: { p1: { title: "Dragon control" } } });

    const response = await app.request("/api/tournaments/cup-1/games/g1");
    expect(response.status).toBe(200);
    const gameDetail = await response.json();
    expect(gameDetail.tournament).toMatchObject({ id: "cup-1", name: "Cup 1", kind: "scored", state: "finished", format: "round-robin+final", maxMinutes: 90, onTimeout: "lp" });
    expect(gameDetail.players).toMatchObject([expect.objectContaining({ id: "p2" }), expect.objectContaining({ id: "p1" })]);
    expect(gameDetail.game).toMatchObject({ id: "g1", durationMs: 60_000,
      decks: { p1: { title: "Dragon control" } } });
  });

  it("keeps live game detail private for non-organizers when live hiding is enabled", async () => {
    vi.stubEnv("YGOSIM_TOURNAMENT_HIDE_LIVE", "1");
    const tournament = fixture();
    tournament.status = "running";
    tournament.games[0]!.status = "running";
    const { app, dir } = seed({ tournament });
    const lock = join(dir, tournament.id, ".runner-lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, `owner-${process.pid}-privacy`), "");
    const publicResponse = await app.request("/api/tournaments/cup-1/games/g1");
    expect(publicResponse.status).toBe(200);
    const publicGame = await publicResponse.json();
    expect(publicGame.tournament.state).toBe("live");
    expect(publicGame.game.decks).toEqual({});
    expect(publicGame.game).not.toHaveProperty("reason");
    expect(publicGame.game).not.toHaveProperty("error");
    expect(publicGame.game).not.toHaveProperty("live");
    expect((await app.request("/api/tournaments/cup-1/games/g1/timeline")).status).toBe(403);
    expect((await app.request("/api/tournaments/cup-1/games/g1", organizerAccess())).status).toBe(200);
  });

  it("merges a safe seat timeline, supports polling cursors, and emits the terminal result once", async () => {
    const tournament = fixture();
    const game = tournament.games[0]!;
    game.startedAt = "2026-01-01T00:00:00.000Z";
    game.endedAt = "2026-01-01T00:01:00.000Z";
    game.reason = "finished";
    game.decks.p1 = { name: "Alpha", source: "sample", reason: "Use Alpha strategy", main: [1], extra: [] };
    game.decks.p2 = { name: "Beta", source: "custom", reason: "TOKEN=secret", main: [2], extra: [] };
    const p1Decisions = [
      { t: 10, turn: 1, phase: "MAIN1", promptKind: "select_option", options: ["Summon", "Set"], optionIds: ["summon", "set"], choose: [1], reason: "Summon", ms: 4 },
      "not-json",
      { t: 20, promptKind: "mystery_prompt", options: ["Safe"], choose: [], reason: "Pass", ms: 5 },
    ];
    const p2Decisions = [
      { t: 10, turn: 1, phase: "MAIN1", promptKind: "select_option", options: ["Pass"], optionIds: ["pass"], choose: ["pass"], reason: "Pass", ms: 6 },
    ];
    const p1Tools = [
      { t: 5, tool: "enter_match", args: { main: [1], extra: [] }, ok: true, ms: 2 },
      { t: 12, tool: "card_info", args: { query: "Blue-Eyes" }, ok: true, ms: 3 },
      { t: 13, tool: "card_info", args: { query: "Bearer abcdefghijklmnopqrstuvwxyz123456" }, ok: true, ms: 1 },
    ];
    const p2Tools = [
      { t: 6, tool: "enter_match", args: { main: [2], extra: [] }, ok: false, ms: 2 },
    ];
    const { app, gameDir } = seed({
      tournament,
      decisions: p1Decisions.map(row => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n",
      tools: p1Tools.map(row => JSON.stringify(row)).join("\n") + "\n",
    });
    writeFileSync(join(gameDir, "p2.decisions.jsonl"), p2Decisions.map(row => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(join(gameDir, "p2.tools.jsonl"), p2Tools.map(row => JSON.stringify(row)).join("\n") + "\n");

    const firstResponse = await app.request("/api/tournaments/cup-1/games/g1/timeline?include=tools");
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first.final).toBe(true);
    const eventTimes = first.events.map((event: Record<string, unknown>) => Number(event.at));
    expect(eventTimes).toEqual([...eventTimes].sort((a, b) => a - b));
    expect(first.events.every((event: Record<string, unknown>) => !("resultPreview" in event))).toBe(true);
    expect(first.events.filter((event: Record<string, unknown>) => event.type === "tool")).toEqual(expect.arrayContaining([
      expect.objectContaining({ at: 12, seat: 0, tool: "card_info", summary: "Blue-Eyes" }),
    ]));
    expect(first.events.find((event: Record<string, unknown>) => event.type === "tool" && event.at === 13)).toBeUndefined();
    const decisions = first.events.filter((event: Record<string, unknown>) => event.type === "decision");
    expect(decisions.filter((event: Record<string, unknown>) => event.at === 10).map((event: Record<string, unknown>) => event.seat)).toEqual([0, 1]);
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ at: 10, seat: 0, choice: ["Summon"], prompt: { kind: "select_option", label: "Choose an effect" } }),
      expect.objectContaining({ at: 10, seat: 1, choice: ["Pass"] }),
      expect.objectContaining({ at: 20, seat: 0, choice: ["Pass"], prompt: { kind: "mystery_prompt", label: "mystery prompt" } }),
    ]));
    expect(decisions.find((event: Record<string, unknown>) => event.at === 10 && event.seat === 0)).toBeTruthy();
    expect(first.events.find((event: Record<string, unknown>) => event.type === "deck" && event.seat === 0)).toMatchObject({ at: 5, title: "Alpha", reason: "Use Alpha strategy" });
    expect(first.events.find((event: Record<string, unknown>) => event.type === "deck" && event.seat === 1)).toMatchObject({ at: 0, title: "Beta", reason: "" });
    expect(first.events.filter((event: Record<string, unknown>) => event.type === "result")).toEqual([
      expect.objectContaining({ at: 60_000, winner: "p1", reason: "finished" }),
    ]);

    const decoded = JSON.parse(Buffer.from(first.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(decoded).toMatchObject({ v: 1, tid: "cup-1", gid: "g1", decisions: [3, 1], tools: [3, 1], decks: [true, true], result: true, lastAt: 60_000 });
    const empty = await (await app.request(`/api/tournaments/cup-1/games/g1/timeline?include=tools&cursor=${first.cursor}`)).json();
    expect(empty.events).toEqual([]);
    expect(empty.final).toBe(true);

    appendFileSync(join(gameDir, "p1.decisions.jsonl"), `${JSON.stringify({ t: 30, promptKind: "select_option", options: ["Draw"], choose: [4] })}\n`);
    appendFileSync(join(gameDir, "p1.tools.jsonl"), `${JSON.stringify({ t: 31, tool: "card_info", args: { query: "Dark Magician" }, ok: true, ms: 1 })}\n`);
    const appended = await (await app.request(`/api/tournaments/cup-1/games/g1/timeline?include=tools&cursor=${empty.cursor}`)).json();
    expect(appended.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "decision", at: 30, choice: ["4"] }),
      expect.objectContaining({ type: "tool", at: 31, summary: "Dark Magician" }),
    ]));
    expect(appended.events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "result" })]));

    writeFileSync(join(gameDir, "p1.decisions.jsonl"), `${JSON.stringify({ t: 40, promptKind: "select_option", options: ["Draw"], choose: [1] })}\n`);
    writeFileSync(join(gameDir, "p1.tools.jsonl"), `${JSON.stringify({ t: 41, tool: "card_info", args: { query: "Red-Eyes" }, ok: true, ms: 1 })}\n`);
    const reset = await (await app.request(`/api/tournaments/cup-1/games/g1/timeline?include=tools&cursor=${appended.cursor}`)).json();
    expect(reset.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "decision", at: 40 }),
      expect.objectContaining({ type: "tool", at: 41 }),
    ]));
    expect((await app.request("/api/tournaments/cup-1/games/g1/timeline?cursor=not-a-cursor")).status).toBe(400);
  });

  it("uses relative epoch timestamps, human prompt labels, and terminal final flags", async () => {
    const tournament = fixture();
    const game = tournament.games[0]!;
    game.startedAt = "2026-01-01T00:00:00.000Z";
    game.endedAt = "2026-01-01T00:00:10.000Z";
    const start = Date.parse(game.startedAt);
    const decisions = [
      { t: start + 5, promptKind: "idle", options: ["Go"], choose: [1] },
      { t: start + 6, promptKind: "battle_idle", options: ["Attack"], choose: [1] },
      { t: start + 7, promptKind: "select_chain", options: ["Chain"], choose: [1] },
      { t: start + 8, promptKind: "unknown_kind", options: ["Fallback"], choose: [1] },
    ];
    const { app } = seed({ tournament, decisions: decisions.map(row => JSON.stringify(row)).join("\n") + "\n" });
    const body = await (await app.request("/api/tournaments/cup-1/games/g1/timeline")).json();
    expect(body.final).toBe(true);
    expect(body.events.filter((event: Record<string, unknown>) => event.type === "tool")).toEqual([]);
    expect(body.events.filter((event: Record<string, unknown>) => event.type === "decision")).toEqual(expect.arrayContaining([
      expect.objectContaining({ at: 5, prompt: { kind: "idle", label: "Main phase" } }),
      expect.objectContaining({ at: 6, prompt: { kind: "battle_idle", label: "Battle phase" } }),
      expect.objectContaining({ at: 7, prompt: { kind: "select_chain", label: "Chain response" } }),
      expect.objectContaining({ at: 8, prompt: { kind: "unknown_kind", label: "unknown kind" } }),
    ]));

    const pendingTournament = fixture();
    pendingTournament.games[0]!.status = "pending";
    const pending = seed({ tournament: pendingTournament });
    expect((await (await pending.app.request("/api/tournaments/cup-1/games/g1/timeline")).json()).final).toBe(false);
    const errorTournament = fixture();
    errorTournament.games[0]!.status = "error";
    const error = seed({ tournament: errorTournament });
    expect((await (await error.app.request("/api/tournaments/cup-1/games/g1/timeline")).json()).final).toBe(true);
  });

  it("removes persisted live state from hidden game resources", async () => {
    vi.stubEnv("YGOSIM_TOURNAMENT_HIDE_LIVE", "1");
    const tournament = fixture();
    tournament.games[0]!.status = "running";
    Object.assign(tournament.games[0]!, { live: { turn: 9, phase: "private", lp: [100, 200] } });
    const { app } = seed({ tournament });
    const detail = await (await app.request("/api/tournaments/cup-1")).json();
    const match = await (await app.request("/api/tournaments/cup-1/games/g1")).json();
    expect(detail.games[0]).not.toHaveProperty("live");
    expect(match.game).not.toHaveProperty("live");
  });

  it("uses current source times for a result after logs restart", async () => {
    const tournament = fixture();
    tournament.status = "running";
    const game = tournament.games[0]!;
    game.status = "running";
    game.decks = {};
    delete game.endedAt;
    const { app, dir, gameDir } = seed({ tournament, decisions: `${JSON.stringify({ t: 200, promptKind: "idle", choose: [], reason: "old attempt" })}\n`, tools: "" });
    writeFileSync(join(gameDir, "p2.decisions.jsonl"), `${JSON.stringify({ t: 50, promptKind: "idle", choose: [] })}\n`);
    const first = await (await app.request("/api/tournaments/cup-1/games/g1/timeline")).json();
    expect(first.final).toBe(false);
    writeFileSync(join(gameDir, "p1.decisions.jsonl"), `${JSON.stringify({ t: 10, promptKind: "idle", choose: [] })}\n`);
    game.status = "done";
    writeTournament(dir, tournament);
    const second = await (await app.request(`/api/tournaments/cup-1/games/g1/timeline?cursor=${first.cursor}`)).json();
    expect(second.events).toEqual([
      expect.objectContaining({ type: "decision", at: 10, seat: 0 }),
      expect.objectContaining({ type: "result", at: 50 }),
    ]);
    expect(second.final).toBe(true);
  });

  it("derives activity from a live lock owner and ignores stale locks", async () => {
    const tournament = fixture(); tournament.status = "running"; tournament.paused = true;
    tournament.pausedAt = "2026-01-01T00:02:00.000Z";
    const { root, dir, app } = seed({ tournament });
    const lock = join(dir, tournament.id, ".runner-lock");
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    await once(owner, "spawn");
    const exited = once(owner, "exit");
    const check = async (active: boolean) => {
      const summary = (await (await app.request("/api/tournaments")).json())[0];
      const detail = await (await app.request("/api/tournaments/cup-1")).json();
      expect(summary).toMatchObject({ status: "running", paused: true, active });
      expect(detail).toMatchObject({ paused: true, pausedAt: tournament.pausedAt, active });
      for (const result of [summary, detail]) {
        expect(result).not.toHaveProperty("pid");
        expect(JSON.stringify(result)).not.toContain(root);
        expect(JSON.stringify(result)).not.toContain("owner-");
      }
    };
    try {
      await check(false);
      mkdirSync(lock);
      await check(false);
      const ownerPath = join(lock, `owner-${owner.pid}-fixture`);
      writeFileSync(ownerPath, "");
      await check(true);
      owner.kill("SIGTERM"); await exited;
      await check(false);
      unlinkSync(ownerPath);
      writeFileSync(join(lock, "invalid-owner"), "");
      await check(false);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) { owner.kill("SIGTERM"); await exited; }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes only the latest board summary from a bounded replay tail", async () => {
    const tournament = fixture();
    tournament.games[0]!.status = "running";
    tournament.games[0]!.startedAt = "2026-01-01T00:00:00.000Z";
    const state = { turn: 4, phase: "main1", turnPlayer: 1, lp: [6300, 2100], hands: ["private"], decks: ["secret"] };
    const frame = (t: number, state: unknown) => JSON.stringify({ t, msg: { type: "events", state } });
    const { app } = seed({ tournament, replay: "x".repeat(300_000) + "\n" + frame(1000, { ...state, turn: 3 }) + "\n" + frame(2000, state) + '\n{"t":3000,"msg":{"type":"room"}}\nmalformed\n{"t":4000' });
    const detail = await (await app.request("/api/tournaments/cup-1")).json();
    expect(detail.games[0].live).toEqual({ turn: 4, phase: "main1", turnPlayer: 1, lp: [6300, 2100], at: "2026-01-01T00:00:02.000Z" });
    vi.stubEnv("YGOSIM_TOURNAMENT_HIDE_LIVE", "1");
    expect((await (await app.request("/api/tournaments/cup-1")).json()).games[0].live).toBeUndefined();
    expect((await (await app.request("/api/tournaments/cup-1", organizerAccess())).json()).games[0].live).toBeDefined();
  });
  it.each([true, false])("omits live state without replay state (missing file: %s)", async skipReplay => {
    const tournament = fixture(); tournament.games[0]!.status = "running";
    const { app } = seed({ tournament, skipReplay });
    expect((await (await app.request("/api/tournaments/cup-1")).json()).games[0].live).toBeUndefined();
  });

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
    expect(await list.json()).toMatchObject([{
      id: "cup-1", name: "Cup 1", createdAt: "2026-01-01T00:00:00.000Z", status: "done",
      active: false, paused: false,
      players: tournament.players, done: 1, total: 1,
    }]);

    const detail = await app.request("/api/tournaments/cup-1");
    expect(detail.status).toBe(200);
    expect((await detail.json()).standings[0]).toMatchObject({ id: "p1", wins: 1, points: 3 });
    expect(await (await app.request("/api/tournaments/cup-1/games/g1/replay")).json()).toEqual([{ t: 1, msg: { type: "duel" } }]);
    expect(await (await app.request("/api/tournaments/cup-1/games/g1/decisions/p1")).json()).toEqual([{ t: 2, reason: "play" }]);
    const corsResponse = await app.request("/api/tournaments/cup-1/games/g1/activity/p1", { headers: { Origin: "http://example.com" } });
    expect(corsResponse.headers.get("Access-Control-Expose-Headers")).toContain("X-Row-Count");
    expect((await (await app.request("/api/leaderboard")).json()).players[0]).toMatchObject({ id: "p1", points: 3 });
  });

  it.each(["pending", "running", "error"] as const)("publishes live detail and decisions by default for %s games", async status => {
    const tournament = fixture();
    tournament.games[0]!.status = status;
    tournament.games[0]!.reason = "Board configuration";
    tournament.games[0]!.error = "Retry needed";
    const { app } = seed({ tournament });
    expect((await (await app.request("/api/tournaments/cup-1")).json()).games).toMatchObject(tournament.games);
    expect(await (await app.request("/api/tournaments/cup-1/games/g1/decisions/p1")).json()).toEqual([{ t: 2, reason: "play" }]);
    expect((await app.request("/api/tournaments/cup-1/games/g1/activity/p1")).status).toBe(200);
    expect(await (await app.request("/api/tournaments/cup-1/report.md")).text()).toContain("p1: Alpha — r");
    for (const kind of ["tools", "transcript", "stderr"]) {
      expect((await app.request(`/api/tournaments/cup-1/games/g1/${kind}/p1`)).status).toBe(403);
    }
  });

  it("keeps strategy words and filters value-shaped secrets before serving decisions", async () => {
    const strategies = ["Board configuration uses Token: summon a token monster", "No credentials or password needed for this strategy", "Authorization and config are strategy words", "Use the token: to summon Link Spider"];
    const secrets = ["Bearer abcdefghijklmnopqrstuvwxyz123456", "-----BEGIN RSA PRIVATE KEY-----", "sk-abcdefghijklmnopqrst", "a1".repeat(24), "YWJjZGVmMTIzNDU2".repeat(4), "AbCdGhIjKlMnOpQrStUv".repeat(3), "KEY=secret-value", "TOKEN=secret-value", "OPENAI_API_KEY=[redacted]", "process.env"];
    const rows = [...strategies, ...secrets].map((reason, t) => ({ t, reason }));
    const { app } = seed({ decisions: rows.map(row => JSON.stringify(row)).join("\n") });
    const response = await app.request("/api/tournaments/cup-1/games/g1/decisions/p1");
    expect(response.headers.get("X-Row-Count")).toBe(String(rows.length));
    expect(await response.json()).toEqual(rows.map((row, i) => i < strategies.length ? row : { t: row.t }));
  });

  it("slices raw decision indexes before sanitizing for public and organizer readers", async () => {
    const { app } = seed({ decisions: '[{"unused":true}]\nnull\n{"t":2,"reason":"play"}\nnot-json\n{"t":3}\n' });
    for (const access of [undefined, organizerAccess()]) {
      const response = await app.request("/api/tournaments/cup-1/games/g1/decisions/p1?from=2", access);
      expect(response.headers.get("X-Row-Count")).toBe("4");
      expect(await response.json()).toEqual([{ t: 2, reason: "play" }, { t: 3 }]);
      expect(await (await app.request("/api/tournaments/cup-1/games/g1/decisions/p1?from=99", access)).json()).toEqual([]);
    }
  });

  it("serves short safe activity summaries with stable raw indexes", async () => {
    const tools = [
      { t: 1, tool: "act", ok: true, ms: 5, args: { choose: [1, "link"] }, resultPreview: "PRIVATE_RESULT" },
      { t: 2, tool: "enter_match", ok: true, ms: 6, args: { main: [1, 2], extra: [3], side: [] } },
      { t: 3, tool: "card_info", ok: true, ms: 1, args: { query: "Token\nmonster" } },
      { t: 4, tool: "card_info", ok: true, ms: 1, args: { name: "TOKEN=secret" } },
      { t: 5, tool: "wait_for_turn", ok: true, ms: 2, resultPreview: "## DUEL OVER private detail" },
      { t: 6, tool: "get_state", ok: false, ms: 3, resultPreview: "PRIVATE_ERROR" },
      { t: 7, tool: "enter_match", ok: false, ms: 1, args: { ydk: "#main\n1\n2\n#extra\n3\n!side\n4" } },
      { t: 8, tool: "unknown", ok: true, ms: 1, args: { secret: "PRIVATE" } },
      { t: 9, tool: "enter_match", ok: true, ms: 1, args: { deck: "Alpha" } },
    ];
    const { app } = seed({ tools: tools.map(row => JSON.stringify(row)).join("\n"),
      decisions: JSON.stringify({ t: 1, options: ["Summon Token", "Link Spider"], optionIds: ["token", "link"], choose: [1, "link"] }) });
    const response = await app.request("/api/tournaments/cup-1/games/g1/activity/p1?from=1");
    expect(response.headers.get("X-Row-Count")).toBe("9");
    expect(await response.json()).toEqual([
      { t: 2, tool: "enter_match", ok: true, ms: 6, summary: "Main 2, Extra 1, Side 0" },
      { t: 3, tool: "card_info", ok: true, ms: 1, summary: "Token monster" },
      { t: 5, tool: "wait_for_turn", ok: true, ms: 2, summary: "DUEL OVER" },
      { t: 6, tool: "get_state", ok: false, ms: 3, summary: "Tool failed" },
      { t: 7, tool: "enter_match", ok: false, ms: 1, summary: "Main 2, Extra 1, Side 1" },
      { t: 9, tool: "enter_match", ok: true, ms: 1, summary: "Main 0, Extra 0, Side 0" },
    ]);
    expect((await (await app.request("/api/tournaments/cup-1/games/g1/activity/p1")).json())[0].summary).toBe("Summon Token; Link Spider");
    expect(await (await app.request("/api/tournaments/cup-1/games/g1/activity/p1?from=99")).json()).toEqual([]);
    expect((await app.request("/api/tournaments/cup-1/games/g1/activity/p3")).status).toBe(404);
    expect((await app.request("/api/tournaments/cup-1/games/g1/activity/bad.player")).status).toBe(400);
    const unsafeAct = seed({ tools: JSON.stringify(tools[0]),
      decisions: JSON.stringify({ t: 1, options: ["Bearer abcdefghijklmnopqrstuvwxyz123456"], choose: [1] }) });
    expect(await (await unsafeAct.app.request("/api/tournaments/cup-1/games/g1/activity/p1")).json()).toEqual([]);
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

  it("slices replay frames from ?from= and reports X-Frame-Count", async () => {
    const { app } = seed();
    const full = await app.request("/api/tournaments/cup-1/games/g1/replay");
    expect(full.status).toBe(200);
    expect(full.headers.get("x-frame-count")).toBe("3");
    expect(await full.json()).toEqual([
      { t: 1, msg: { type: "duel" } },
      { t: 2, msg: { type: "state" } },
      { t: 3, msg: { type: "end" } },
    ]);

    const sliced = await app.request("/api/tournaments/cup-1/games/g1/replay?from=1");
    expect(sliced.status).toBe(200);
    expect(sliced.headers.get("x-frame-count")).toBe("3");
    expect(await sliced.json()).toEqual([
      { t: 2, msg: { type: "state" } },
      { t: 3, msg: { type: "end" } },
    ]);

    const empty = await app.request("/api/tournaments/cup-1/games/g1/replay?from=99");
    expect(empty.status).toBe(200);
    expect(empty.headers.get("x-frame-count")).toBe("3");
    expect(await empty.json()).toEqual([]);
  });

  it("returns 404 for a missing replay, tournament, or game", async () => {
    const { app } = seed({ skipReplay: true });
    expect((await app.request("/api/tournaments/cup-1/games/g1/replay")).status).toBe(404);
    expect((await app.request("/api/tournaments/missing/games/g1/replay")).status).toBe(404);
    expect((await app.request("/api/tournaments/cup-1/games/nope/replay")).status).toBe(404);
    expect((await app.request("/api/tournaments/cup-1/games/g1/replay/../replay")).status).toBe(404);
  });

  it("serves tool rows, skips malformed lines, and honors ?limit=", async () => {
    const { app } = seed();
    const access = organizerAccess();
    const all = await app.request("/api/tournaments/cup-1/games/g1/tools/p1", access);
    expect(all.status).toBe(200);
    expect(await all.json()).toEqual([
      { t: 1, tool: "act", args: { n: 1 }, ok: true, ms: 5 },
      { t: 2, tool: "wait", args: {}, ok: true, ms: 7 },
      { t: 3, tool: "get_state", args: {}, ok: false, ms: 1 },
    ]);

    const limited = await app.request("/api/tournaments/cup-1/games/g1/tools/p1?limit=1", access);
    expect(await limited.json()).toEqual([{ t: 1, tool: "act", args: { n: 1 }, ok: true, ms: 5 }]);
    expect(await (await app.request("/api/tournaments/cup-1/games/g1/tools/p1?limit=0", access)).json()).toEqual([]);
    expect((await app.request("/api/tournaments/cup-1/games/g1/tools/p3", access)).status).toBe(404);
    expect((await app.request("/api/tournaments/cup-1/games/g1/tools/bad.player", access)).status).toBe(400);
  });

  it("does not follow a tools symlink out of the tournament root", async () => {
    const { root, dir, gameDir } = seed();
    const outside = join(root, "secret.tools.jsonl");
    writeFileSync(outside, '{"t":9,"tool":"leaked"}\n');
    unlinkSync(join(gameDir, "p1.tools.jsonl"));
    symlinkSync(outside, join(gameDir, "p1.tools.jsonl"));
    const app = buildTournamentApi(dir);
    const res = await app.request("/api/tournaments/cup-1/games/g1/tools/p1", organizerAccess());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    const activity = await app.request("/api/tournaments/cup-1/games/g1/activity/p1");
    expect(activity.headers.get("X-Row-Count")).toBe("0");
    expect(await activity.json()).toEqual([]);
  });

  it("returns transcript and stderr as text/plain and 404s when missing", async () => {
    const { app } = seed({
      transcript: "line-one\n\n\nline-two\n",
      stderr: "err-one\n\n\nerr-two\n",
    });
    const access = organizerAccess();
    const transcript = await app.request("/api/tournaments/cup-1/games/g1/transcript/p1", access);
    expect(transcript.status).toBe(200);
    expect(transcript.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await transcript.text()).toBe("line-one\nline-two\n");

    const stderr = await app.request("/api/tournaments/cup-1/games/g1/stderr/p1", access);
    expect(stderr.status).toBe(200);
    expect(stderr.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await stderr.text()).toBe("err-one\n\n\nerr-two\n");

    expect((await app.request("/api/tournaments/cup-1/games/g1/transcript/p2", access)).status).toBe(404);
    expect((await app.request("/api/tournaments/cup-1/games/g1/stderr/p2", access)).status).toBe(404);
    expect((await app.request("/api/tournaments/cup-1/games/g1/transcript/bad.player", access)).status).toBe(400);
    expect((await app.request("/api/tournaments/cup-1/games/g1/stderr/bad.player", access)).status).toBe(400);
  });

  it("truncates transcript and stderr to the last 512KB", async () => {
    const start = Buffer.from("HEAD_MARKER");
    const end = Buffer.from("TAIL_MARKER");
    const middle = Buffer.alloc(512 * 1024, 97);
    const payload = Buffer.concat([start, middle, end]);
    const { app } = seed({ transcript: payload, stderr: payload });
    const access = organizerAccess();

    const transcript = await (await app.request("/api/tournaments/cup-1/games/g1/transcript/p1", access)).text();
    const stderr = await (await app.request("/api/tournaments/cup-1/games/g1/stderr/p1", access)).text();
    expect(transcript).toContain("TAIL_MARKER");
    expect(transcript).not.toContain("HEAD_MARKER");
    expect(stderr).toContain("TAIL_MARKER");
    expect(stderr).not.toContain("HEAD_MARKER");
    expect(Buffer.byteLength(transcript)).toBeLessThanOrEqual(512 * 1024);
    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(512 * 1024);
  });

  it("exports the leaderboard as quoted CSV", async () => {
    const tournament = fixture();
    tournament.players[0]!.label = 'Odd, "name"';
    const { app } = seed({ tournament });
    organizerAccess();
    const res = await app.request("/api/leaderboard.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    const body = await res.text();
    const [header, ...rows] = body.trimEnd().split("\n");
    expect(header).toBe("id,label,model,elo,played,wins,losses,draws,points,winRate,avgTurns,avgDecisionMs,invalidRate,reasonRate,crashes");
    expect(rows.some(row => row.includes('"Odd, ""name"""'))).toBe(true);
    expect(rows[0]).toMatch(/^p1,/);
  });

  it("renders a markdown tournament report", async () => {
    const { app } = seed();
    const res = await app.request("/api/tournaments/cup-1/report.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/markdown/);
    const body = await res.text();
    expect(body).toContain("# Cup 1");
    expect(body).toContain("## Standings");
    expect(body).toContain("| id | label | model | elo | played | wins | losses | draws | points | winRate |");
    expect(body).toMatch(/\| p1 \| One \|/);
    expect(body).toContain("## Head-to-head");
    expect(body).toContain("### p1 vs p2");
    expect(body).toContain("p1 won");
    expect(body).toContain("## Per-game deck choices");
    expect(body).toContain("p1: Alpha — r");
    expect(body).toContain("p2: Beta — r");
    expect(body).toContain("## Deck meta");
    expect(body).toContain("Alpha");
    expect(body).toContain("sample");
    expect(body).toContain("p1×1");
    expect((await app.request("/api/tournaments/missing/report.md")).status).toBe(404);
    expect((await app.request("/api/tournaments/bad.id/report.md")).status).toBe(400);
  });

  it.each(["pending", "running", "error"] as const)("redacts private deck data and report details for %s games", async status => {
    vi.stubEnv("YGOSIM_TOURNAMENT_HIDE_LIVE", "1");
    const tournament = fixture();
    const completed = { ...fixture().games[0]!, id: "g2" };
    const game = tournament.games[0]!;
    game.status = status;
    game.reason = "LIVE_GAME_REASON";
    game.error = "LIVE_HOST_DIAGNOSTIC";
    game.decks.p1 = { name: "Live Alpha", source: "custom", reason: "LIVE_DECK_REASON", main: [24680135], extra: [13580246] };
    game.decks.p2 = { name: "Live Beta", source: "sample", reason: "LIVE_OTHER_REASON", main: [86420975], extra: [57902468] };
    tournament.games.push(completed);
    const { app } = seed({ tournament });
    organizerAccess();

    const res = await app.request("/api/tournaments/cup-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("vary")).toContain("Authorization");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const detail = await res.json();
    expect(detail.games[0].decks).toEqual({});
    expect(detail.games[0]).not.toHaveProperty("reason");
    expect(detail.games[0]).not.toHaveProperty("error");
    expect(JSON.stringify(detail)).not.toMatch(/LIVE_|Live Alpha|Live Beta|24680135|13580246|86420975|57902468/);
    expect(detail.games[1]).toMatchObject(completed);
    expect(detail.standings[0]).toMatchObject({ id: "p1", wins: 1, points: 3 });

    const report = await app.request("/api/tournaments/cup-1/report.md");
    expect(report.status).toBe(200);
    const markdown = await report.text();
    expect(markdown).toContain(`- g1: ${status}`);
    expect(markdown).toContain("Deck choices are private until the game is done.");
    expect(markdown).not.toMatch(/LIVE_|Live Alpha|Live Beta|24680135|13580246/);
    expect(markdown).toContain("p1: Alpha — r");
    expect(markdown).toContain("| Alpha | sample | 1 | 1 | p1×1 |");
    expect((await app.request("/api/tournaments")).status).toBe(200);
    expect((await app.request("/api/leaderboard")).status).toBe(200);
    expect((await app.request("/api/leaderboard.csv")).status).toBe(200);
  });

  it.each(["pending", "running", "error"] as const)("denies public decision and raw log access for %s games", async status => {
    vi.stubEnv("YGOSIM_TOURNAMENT_HIDE_LIVE", "1");
    const tournament = fixture();
    tournament.games[0]!.status = status;
    const { app } = seed({ tournament, transcript: "PRIVATE_TRANSCRIPT", stderr: "PRIVATE_STDERR" });
    for (const kind of ["decisions", "activity", "tools", "transcript", "stderr"]) {
      const res = await app.request(`/api/tournaments/cup-1/games/g1/${kind}/p1`);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "organizer access required" });
    }
  });

  it.each([undefined, ""])("fails closed for completed raw logs without a configured organizer credential", async setting => {
    vi.stubEnv("YGOSIM_TOURNAMENT_READ_TOKEN", setting);
    const { app } = seed({ transcript: "PRIVATE_TRANSCRIPT", stderr: "PRIVATE_STDERR" });
    for (const kind of ["tools", "transcript", "stderr"]) {
      for (const init of [undefined, { headers: { Authorization: `Bearer ${fixture().id}` } }]) {
        const res = await app.request(`/api/tournaments/cup-1/games/g1/${kind}/p1`, init);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "organizer access required" });
      }
    }
    expect(await (await app.request("/api/tournaments/cup-1/games/g1/decisions/p1")).json()).toEqual([{ t: 2, reason: "play" }]);
  });

  it("allows configured organizer access to live decks, decisions, tools, transcript, stderr and reports", async () => {
    vi.stubEnv("YGOSIM_TOURNAMENT_HIDE_LIVE", "1");
    const tournament = fixture();
    tournament.status = "running";
    const game = tournament.games[0]!;
    game.status = "running";
    game.reason = "LIVE_GAME_REASON";
    game.decks.p1 = { name: "Alpha", source: "sample", reason: "LIVE_DECK_REASON", main: [24680135], extra: [13580246] };
    const decisions = [{ t: 2, reason: "play", config: { account: "PRIVATE_DIAGNOSTIC" } }];
    const tools = [{ t: 3, tool: "act", args: { choose: [0], config: "PRIVATE_CONFIG" }, resultPreview: "PRIVATE_RESULT", ok: true, ms: 4 }];
    const { app } = seed({
      tournament,
      decisions: decisions.map(row => JSON.stringify(row)).join("\n"),
      tools: tools.map(row => JSON.stringify(row)).join("\n"),
      transcript: "PRIVATE_TRANSCRIPT\n\nHOST_DIAGNOSTIC\n",
      stderr: "PRIVATE_STDERR\n\nHOST_DIAGNOSTIC\n",
    });
    const access = organizerAccess();

    const detail = await app.request("/api/tournaments/cup-1", access);
    expect(detail.status).toBe(200);
    expect(detail.headers.get("cache-control")).toBe("no-store");
    expect((await detail.json()).games).toMatchObject(tournament.games);
    const activity = await app.request("/api/tournaments/cup-1/games/g1/activity/p1", access);
    expect(activity.status).toBe(200);
    expect(await activity.json()).toEqual([{ t: 3, tool: "act", ok: true, ms: 4, summary: "No option labels available" }]);
    for (const [kind, rows] of [["decisions", decisions], ["tools", tools]] as const) {
      const res = await app.request(`/api/tournaments/cup-1/games/g1/${kind}/p1`, access);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(rows);
    }
    expect(await (await app.request("/api/tournaments/cup-1/games/g1/transcript/p1", access)).text()).toBe("PRIVATE_TRANSCRIPT\nHOST_DIAGNOSTIC\n");
    expect(await (await app.request("/api/tournaments/cup-1/games/g1/stderr/p1", access)).text()).toBe("PRIVATE_STDERR\n\nHOST_DIAGNOSTIC\n");
    const report = await (await app.request("/api/tournaments/cup-1/report.md", access)).text();
    expect(report).toContain("LIVE\\_GAME\\_REASON");
    expect(report).toContain("p1: Alpha — LIVE\\_DECK\\_REASON");
    expect(report).toContain("| Alpha | sample | 1 | 0 | p1×1 |");

    const publicDetail = await (await app.request("/api/tournaments/cup-1")).json();
    expect(publicDetail.games[0].decks).toEqual({});
    expect(await (await app.request("/api/tournaments/cup-1/report.md")).text()).not.toContain("LIVE\\_DECK\\_REASON");
    expect((await app.request("/api/tournaments/cup-1/games/g1/decisions/p1")).status).toBe(403);
  });

  it("denies missing, malformed and incorrect organizer credentials without leaking live details", async () => {
    vi.stubEnv("YGOSIM_TOURNAMENT_HIDE_LIVE", "1");
    const tournament = fixture();
    tournament.games[0]!.status = "running";
    tournament.games[0]!.decks.p1!.reason = "LIVE_DECK_REASON";
    const { app } = seed({ tournament, transcript: "PRIVATE_TRANSCRIPT", stderr: "PRIVATE_STDERR" });
    organizerAccess();
    for (const init of [
      undefined,
      { headers: { Authorization: `Bearer ${fixture().id.toUpperCase()}` } },
      { headers: { Authorization: `Bearer ${fixture().players[0]!.id}` } },
      { headers: { Authorization: `Basic ${fixture().id}` } },
      { headers: { Authorization: "Bearer" } },
      { headers: { Authorization: `Bearer ${fixture().id} extra` } },
    ]) {
      for (const kind of ["decisions", "activity", "tools", "transcript", "stderr"]) {
        const res = await app.request(`/api/tournaments/cup-1/games/g1/${kind}/p1`, init);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "organizer access required" });
      }
      expect((await (await app.request("/api/tournaments/cup-1", init)).json()).games[0].decks).not.toHaveProperty("p1");
      expect(await (await app.request("/api/tournaments/cup-1/report.md", init)).text()).not.toContain("LIVE\\_DECK\\_REASON");
    }
  });

  it("publishes only safe completed decision fields while retaining raw rows for organizers", async () => {
    const safe = {
      t: 2, turn: 3, phase: "MAIN1", promptId: "prompt-1", promptKind: "select",
      options: ["Summon Alpha", "Create a token", "Basic Insect"], choose: [0, "summon"], reason: "Create a token to protect my LP.", ms: 10,
      toolMs: 100, latencyKind: "response", optionIds: ["summon", "token", "basic"], selected: ["summon"],
    };
    const rows = [
      { ...safe, config: { account: "PRIVATE_ACCOUNT" }, credentials: { apiKey: "[redacted]" }, resultPreview: "PRIVATE_RESULT", args: { account: "PRIVATE_ARGS" } },
      { t: 3, phase: "MAIN2", reason: "OPENAI_API_KEY=[redacted]", promptId: "credentials dump", options: ["play", "Authorization: [redacted]"], choose: [0, { config: "PRIVATE_CONFIG" }] },
      { t: 4, reason: "process.env config dump: {}", options: ["config.json"], choose: ["password = [redacted]"], ms: { diagnostic: "PRIVATE_LATENCY" } },
      { t: 5, reason: '{"client_secret":"[redacted]"}', promptKind: "sessionToken = [redacted]", phase: { diagnostic: "PRIVATE_PHASE" } },
      { config: "PRIVATE_CONFIG_ONLY" },
      "PRIVATE_RAW_ROW", null, [],
    ];
    const { app } = seed({ decisions: `${rows.map(row => JSON.stringify(row)).join("\n")}\nnot-json\n` });
    const res = await app.request("/api/tournaments/cup-1/games/g1/decisions/p1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([safe, { t: 3, phase: "MAIN2", promptId: "credentials dump", options: ["play", "Authorization: [redacted]"] }, { t: 4, options: ["config.json"] }, { t: 5 }]);
    const access = organizerAccess();
    const organizer = await app.request("/api/tournaments/cup-1/games/g1/decisions/p1", access);
    expect(organizer.status).toBe(200);
    expect(await organizer.json()).toEqual(rows);
    expect((await app.request("/api/tournaments/cup-1/games/g1/tools/p1")).status).toBe(403);
  });

  it("does not follow replay, decision, transcript or stderr symlinks outside the storage root", async () => {
    const { root, gameDir, app } = seed();
    const outside = join(root, "private-log");
    writeFileSync(outside, '{"t":9,"reason":"PRIVATE_LOG"}\n');
    for (const file of ["replay.jsonl", "p1.decisions.jsonl"]) unlinkSync(join(gameDir, file));
    for (const file of ["replay.jsonl", "p1.decisions.jsonl", "p1.transcript.jsonl", "p1.stderr.log"]) {
      symlinkSync(outside, join(gameDir, file));
    }
    const access = organizerAccess();
    expect((await app.request("/api/tournaments/cup-1/games/g1/replay", access)).status).toBe(404);
    expect(await (await app.request("/api/tournaments/cup-1/games/g1/decisions/p1", access)).json()).toEqual([]);
    expect(await (await app.request("/api/tournaments/cup-1/games/g1/decisions/p1")).json()).toEqual([]);
    expect((await app.request("/api/tournaments/cup-1/games/g1/transcript/p1", access)).status).toBe(404);
    expect((await app.request("/api/tournaments/cup-1/games/g1/stderr/p1", access)).status).toBe(404);
    const timeline = await app.request("/api/tournaments/cup-1/games/g1/timeline?include=tools", access);
    expect(timeline.status).toBe(200);
    expect(JSON.stringify(await timeline.json())).not.toContain("PRIVATE_LOG");
  });

  it("escapes Markdown and HTML data consistently in every report section", async () => {
    const tournament = fixture();
    tournament.name = "<Cup & Co> | *title*\r\n[link]";
    tournament.players[0]!.id = "p_1";
    tournament.players[1]!.id = "p_2";
    tournament.players[0]!.label = "One `name` \\";
    tournament.players[0]!.model = "model_[x]";
    const game = tournament.games[0]!;
    game.id = "g_1|bad";
    game.seats = ["p_1", "p_2"];
    game.winner = "p_1";
    game.reason = "<finish & state>|[why]\r\nsecond line";
    game.decks = {
      p_1: { name: "*Alpha* | <deck>", source: "custom", reason: "Use [strategy] & `act`\nthen \\continue", main: [], extra: [] },
    };
    const { app } = seed({ tournament });
    const report = await app.request("/api/tournaments/cup-1/report.md");
    expect(report.status).toBe(200);
    const body = await report.text();
    expect(body).toContain("# &lt;Cup &amp; Co&gt; &#124; \\*title\\* \\[link\\]");
    expect(body).toContain("| p\\_1 | One \\`name\\` \\\\ | model\\_\\[x\\] |");
    expect(body).toContain("### p\\_1 vs p\\_2");
    expect(body).toContain("- g\\_1&#124;bad: p\\_1 won (&lt;finish &amp; state&gt;&#124;\\[why\\] second line)");
    expect(body).toContain("### g\\_1&#124;bad");
    expect(body).toContain("- p\\_1: \\*Alpha\\* &#124; &lt;deck&gt; — Use \\[strategy\\] &amp; \\`act\\` then \\\\continue");
    expect(body).toContain("| \\*Alpha\\* &#124; &lt;deck&gt; | custom | 1 | 1 | p\\_1×1 |");
    expect(body).not.toContain("<Cup");
    expect(body).not.toContain("<deck>");
  });

  it("keeps a truncated UTF-8 log tail within the byte cap without an initial broken character", async () => {
    const payload = Buffer.concat([Buffer.from("HEAD"), Buffer.from("€".repeat(180_000)), Buffer.from("TAIL")]);
    const { app } = seed({ transcript: payload, stderr: payload });
    const access = organizerAccess();
    for (const kind of ["transcript", "stderr"]) {
      const res = await app.request(`/api/tournaments/cup-1/games/g1/${kind}/p1`, access);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain("HEAD");
      expect(body).not.toContain("\ufffd");
      expect(body.endsWith("TAIL")).toBe(true);
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(512 * 1024);
    }
  });

  it("streams tournament change events and closes on abort", async () => {
    const { app } = seed();
    const ac = new AbortController();
    try {
      const res = await app.request("/api/tournaments/cup-1/events", { signal: ac.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      const chunk = new TextDecoder().decode(first.value);
      expect(chunk).toContain("event: change");
      expect(chunk).toMatch(/data: \S+/);
      ac.abort();
      await reader.cancel();
    } finally {
      ac.abort();
    }

    expect((await app.request("/api/tournaments/missing/events")).status).toBe(404);
    expect((await app.request("/api/tournaments/bad.tid/events")).status).toBe(400);
  });
});
