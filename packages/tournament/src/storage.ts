import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { computeLeaderboard } from "./standings.js";
import type { Leaderboard, Tournament } from "./types.js";

const DEFAULT_TOURNAMENT_DIR = fileURLToPath(new URL("../../../data/tournaments/", import.meta.url));

/** Resolve the tournament root, honoring the runtime override on every call. */
export function tournamentDir(): string {
  return process.env.YGOSIM_TOURNAMENT_DIR || DEFAULT_TOURNAMENT_DIR;
}

/** Alias retained for callers using the longer name from the runner API. */
export function tournamentDirectory(): string {
  return tournamentDir();
}

export function safeId(value: string): string {
  if (!safeSegment(value)) throw new Error(`Invalid identifier: ${value}`);
  return value;
}

/** Write JSON or text through a same-directory temporary file and rename. */
export function atomicWrite(filePath: string, data: unknown): void {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true });
  const serialized = typeof data === "string" || data instanceof Uint8Array
    ? data
    : JSON.stringify(data, null, 2);
  const temporary = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temporary, serialized as string | Uint8Array);
    renameSync(temporary, filePath);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}

function safeSegment(segment: string): boolean {
  return /^(?:[A-Za-z0-9][A-Za-z0-9_-]*)$/.test(segment);
}

function safeFileSegment(segment: string): boolean {
  return /^(?:[A-Za-z0-9][A-Za-z0-9_.-]*)$/.test(segment);
}

/**
 * Resolve a path below the tournament root and reject traversal or symlink
 * escapes. Existing paths are realpath-checked so API reads cannot follow a
 * tournament/game link outside the configured data directory.
 */
function safeExistingPath(root: string, segments: string[]): string | undefined {
  if (segments.some((segment, index) => index === segments.length - 1 ? !safeFileSegment(segment) : !safeSegment(segment))) return undefined;
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, ...segments);
  const rel = relative(rootPath, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`)) return undefined;

  let rootReal: string;
  let candidateReal: string;
  try {
    rootReal = realpathSync(rootPath);
    candidateReal = realpathSync(candidate);
  } catch {
    return undefined;
  }
  const candidateRel = relative(rootReal, candidateReal);
  if (candidateRel === ".." || candidateRel.startsWith(`..${sep}`)) return undefined;
  return candidateReal;
}

function readJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Read every valid tournament file below `dir`; a missing directory is empty. */
export function readTournaments(dir = tournamentDir()): Tournament[] {
  if (!existsSync(dir)) return [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }

  const tournaments: Tournament[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !safeSegment(entry.name)) continue;
    const filePath = safeExistingPath(dir, [entry.name, "tournament.json"]);
    if (!filePath || !lstatSync(filePath).isFile()) continue;
    const tournament = readJson<Tournament>(filePath);
    if (tournament
      && tournament.id === entry.name
      && typeof tournament.name === "string"
      && typeof tournament.createdAt === "string"
      && (tournament.status === "running" || tournament.status === "done")
      && Array.isArray(tournament.players)
      && Array.isArray(tournament.games)) {
      tournaments.push(tournament);
    }
  }
  return tournaments.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

/** Backwards-compatible alias used by the runner and older integrations. */
export function getTournamentDir(): string {
  return tournamentDir();
}

export interface TournamentSummary {
  id: string;
  name: string;
  createdAt: string;
  status: Tournament["status"];
  players: Tournament["players"];
  done: number;
  total: number;
}

export function listTournaments(dir = tournamentDir()): TournamentSummary[] {
  return readTournaments(dir).map(tournament => ({
    id: tournament.id,
    name: tournament.name,
    createdAt: tournament.createdAt,
    status: tournament.status,
    players: tournament.players,
    done: tournament.games.filter(game => game.status === "done").length,
    total: tournament.games.length,
  }));
}

/** Promise-shaped compatibility wrapper for older storage callers. */
export async function loadTournaments(dir = tournamentDir()): Promise<Tournament[]> {
  return readTournaments(dir);
}

/** Promise-shaped compatibility wrapper for older storage callers. */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  atomicWrite(filePath, value);
}

export function getTournament(tid: string, dir = tournamentDir()): Tournament | null {
  const filePath = safeExistingPath(dir, [tid, "tournament.json"]);
  if (!filePath || !lstatSync(filePath).isFile()) return null;
  const tournament = readJson<Tournament>(filePath);
  return tournament?.id === tid ? tournament : null;
}

function readJsonLines<T>(filePath: string): T[] {
  try {
    return readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(line => line.trim().length > 0)
      .flatMap(line => {
        try { return [JSON.parse(line) as T]; } catch { return []; }
      });
  } catch {
    return [];
  }
}

export function getReplay(tid: string, gid: string, dir = tournamentDir()): Array<{ t: number; msg: unknown }> {
  const filePath = safeExistingPath(dir, [tid, "games", gid, "replay.jsonl"]);
  return filePath && lstatSync(filePath).isFile() ? readJsonLines<{ t: number; msg: unknown }>(filePath) : [];
}

export function getDecisions(tid: string, gid: string, pid: string, dir = tournamentDir()): unknown[] {
  if (!safeSegment(tid) || !safeSegment(gid) || !safeSegment(pid)) return [];
  const filePath = safeExistingPath(dir, [tid, "games", gid, `${pid}.decisions.jsonl`]);
  return filePath && lstatSync(filePath).isFile() ? readJsonLines<unknown>(filePath) : [];
}

/** Compute the current leaderboard from all tournament files. */
export function getLeaderboard(dir = tournamentDir()): Leaderboard {
  return computeLeaderboard(readTournaments(dir).filter(tournament => tournament.scored === true));
}
