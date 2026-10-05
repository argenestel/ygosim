import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicWrite, getLeaderboard, readTournaments, tournamentDir } from "../src/storage.js";
import type { Tournament } from "../src/types.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tournament(id: string): Tournament {
  return { id, name: id, createdAt: "2026-01-01T00:00:00.000Z", status: "running", format: "round-robin+final", players: [], games: [] };
}

describe("tournament storage", () => {
  it("uses the environment override, tolerates a missing root, and writes atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "ygosim-storage-"));
    roots.push(root);
    const dataDir = join(root, "tournaments");
    vi.stubEnv("YGOSIM_TOURNAMENT_DIR", dataDir);
    expect(tournamentDir()).toBe(dataDir);
    expect(readTournaments()).toEqual([]);
    atomicWrite(join(dataDir, "cup-1", "tournament.json"), tournament("cup-1"));
    expect(readTournaments()).toEqual([tournament("cup-1")]);
  });

  it("does not read tournament files through an outside symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "ygosim-storage-"));
    roots.push(root);
    const outside = join(root, "outside");
    const dataDir = join(root, "tournaments");
    mkdirSync(outside, { recursive: true });
    atomicWrite(join(outside, "tournament.json"), tournament("linked"));
    mkdirSync(dataDir, { recursive: true });
    symlinkSync(outside, join(dataDir, "linked"), "dir");
    expect(readTournaments(dataDir)).toEqual([]);
  });
  it("keeps legacy and validation players out of the official leaderboard without hiding their records", () => {
    const root = mkdtempSync(join(tmpdir(), "ygosim-official-")); roots.push(root);
    for (const [id, scored] of [["legacy", undefined], ["validation", false], ["official", true]] as const) {
      const value = { ...tournament(id), scored, players: [{ id, label: id, cli: "codex" as const, model: "fixture" }] };
      atomicWrite(join(root, id, "tournament.json"), value);
    }
    expect(readTournaments(root)).toHaveLength(3);
    expect(getLeaderboard(root).players.map(player => player.id)).toEqual(["official"]);
  });
});
