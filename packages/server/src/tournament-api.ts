import { Hono } from "hono";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import { timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { computeStandings } from "@ygosim/tournament/standings";
import {
  getDecisions,
  getLeaderboard,
  getTournament,
  listTournaments,
  tournamentDir,
} from "@ygosim/tournament/storage";
import type { Game, Standing, Tournament } from "@ygosim/tournament/types";

type TournamentApiApp = Hono;

const TAIL_LIMIT = 512 * 1024;
const SSE_POLL_MS = 2000;
const CSV_COLUMNS = [
  "id", "label", "model", "elo", "played", "wins", "losses", "draws", "points",
  "winRate", "avgTurns", "avgDecisionMs", "invalidRate", "reasonRate", "crashes",
] as const satisfies readonly (keyof Standing)[];

function validSegment(value: string | undefined): value is string {
  return typeof value === "string" && /^(?:[A-Za-z0-9][A-Za-z0-9_-]*)$/.test(value);
}

function invalidPath(c: Context) {
  return c.json({ error: "invalid path" }, 400);
}

function organizerAuthorized(c: Context): boolean {
  const token = process.env.YGOSIM_TOURNAMENT_READ_TOKEN;
  if (!token) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(c.req.header("Authorization") ?? "");
  if (!match) return false;
  const supplied = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function organizerRequired(c: Context) {
  return c.json({ error: "organizer access required" }, 403);
}

function hideLive(): boolean {
  return process.env.YGOSIM_TOURNAMENT_HIDE_LIVE === "1";
}

const SECRET_TEXT_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/i,
  /-----BEGIN [\w ]*PRIVATE KEY-----/i,
  /\bsk-[A-Za-z0-9_-]{12,}|\b[a-f0-9]{32,}\b/i,
  /\b(?=[A-Za-z0-9+/=_-]{40,}(?![A-Za-z0-9+/=_-]))(?=[A-Za-z0-9+/=_-]*[0-9+/=_-])[A-Za-z0-9+/=_-]{40,}/,
  /\b(?=[A-Za-z]{48,}\b)(?=[A-Za-z]*[a-z])(?=[A-Za-z]*[A-Z])[A-Za-z]{48,}\b/,
  // Assignments and quoted JSON values, rather than natural-language "Token:".
  /\b(?:[A-Za-z_][A-Za-z0-9_]*)?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b(?:\s*=|["']\s*:)\s*\S+/i,
  /process\.env/i,
];

function safeDecisionText(value: unknown): value is string {
  return typeof value === "string" && !SECRET_TEXT_PATTERNS.some(pattern => pattern.test(value));
}

function publicDecisions(rows: unknown[]): Record<string, unknown>[] {
  return rows.flatMap(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const source = row as Record<string, unknown>;
    const decision: Record<string, unknown> = {};
    for (const key of ["t", "turn", "ms", "toolMs"] as const) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) decision[key] = value;
    }
    for (const key of ["phase", "promptId", "promptKind", "reason"] as const) {
      if (safeDecisionText(source[key])) decision[key] = source[key];
    }
    if (source.latencyKind === "response") decision.latencyKind = "response";
    for (const key of ["options", "choose", "optionIds", "selected"] as const) {
      const value = source[key];
      if (Array.isArray(value) && value.every(item => safeDecisionText(item)
        || (key === "choose" && typeof item === "number" && Number.isFinite(item)))) {
        decision[key] = value;
      }
    }
    return Object.keys(decision).length ? [decision] : [];
  });
}

/** Only extract tool-specific public facts; never return diagnostic previews. */
function publicActivity(rows: unknown[], decisions: unknown[], deck?: Game["decks"][string]): Record<string, unknown>[] {
  const byTime = new Map<number, Record<string, unknown>>();
  for (const row of decisions) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      const decision = row as Record<string, unknown>;
      if (typeof decision.t === "number") byTime.set(decision.t, decision);
    }
  }
  return rows.flatMap(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const source = row as Record<string, unknown>;
    if (typeof source.t !== "number" || !Number.isFinite(source.t)
      || typeof source.ms !== "number" || !Number.isFinite(source.ms)
      || typeof source.ok !== "boolean") return [];
    const args = source.args && typeof source.args === "object" && !Array.isArray(source.args)
      ? source.args as Record<string, unknown> : {};
    let summary: string;
    switch (source.tool) {
      case "act": {
        const decision = byTime.get(source.t);
        const options = decision?.options;
        const ids = decision?.optionIds;
        const choices = decision?.choose;
        const labels = Array.isArray(options) && Array.isArray(choices) ? choices.map(choice => {
          const index = typeof choice === "number" ? choice - 1 : Array.isArray(ids) ? ids.indexOf(choice) : -1;
          return options[index];
        }) : [];
        if (!labels.every(safeDecisionText)) return [];
        summary = labels.length ? labels.join("; ") : "No option labels available";
        break;
      }
      case "enter_match": {
        let main = Array.isArray(args.main) ? args.main.length : undefined;
        let extra = Array.isArray(args.extra) ? args.extra.length : 0;
        let side = Array.isArray(args.side) ? args.side.length : 0;
        if (main === undefined && typeof args.deck === "string" && source.ok && deck) {
          main = deck.main.length;
          extra = deck.extra.length;
          side = deck.side?.length ?? 0;
        }
        if (typeof args.ydk === "string") {
          const counts = { main: 0, extra: 0, side: 0 };
          let section: keyof typeof counts = "main";
          for (const line of args.ydk.split(/\r?\n/).map(line => line.trim())) {
            if (line === "#main") section = "main";
            else if (line === "#extra") section = "extra";
            else if (line === "!side") section = "side";
            else if (/^\d+$/.test(line)) counts[section]++;
          }
          ({ main, extra, side } = counts);
        }
        summary = main === undefined ? typeof args.deck === "string" ? "Sample deck requested" : "Deck sizes unavailable"
          : `Main ${main}, Extra ${extra}, Side ${side}`;
        break;
      }
      case "card_info":
        summary = typeof args.query === "string" ? args.query : typeof args.name === "string" ? args.name
          : typeof args.code === "number" && Number.isSafeInteger(args.code) ? `Passcode ${args.code}` : "Card lookup";
        break;
      case "wait_for_turn":
      case "get_state": {
        const preview = typeof source.resultPreview === "string" ? source.resultPreview : "";
        summary = !source.ok ? "Tool failed" : preview.includes("DUEL OVER") ? "DUEL OVER"
          : preview.includes("Your decision") ? "Decision pending"
          : /waiting|opponent acting/i.test(preview) ? "Waiting for opponent" : "State checked";
        break;
      }
      default: return [];
    }
    if (!safeDecisionText(summary)) return [];
    return [{ t: source.t, tool: source.tool, ok: source.ok, ms: source.ms,
      summary: summary.replace(/\s+/g, " ").trim().slice(0, 200) }];
  });
}

/** Mirror of tournament storage: reject traversal and symlink escapes. */
function safeExistingPath(root: string, segments: string[]): string | undefined {
  const fileRe = /^(?:[A-Za-z0-9][A-Za-z0-9_.-]*)$/;
  const dirRe = /^(?:[A-Za-z0-9][A-Za-z0-9_-]*)$/;
  if (segments.some((segment, index) => !(index === segments.length - 1 ? fileRe : dirRe).test(segment))) {
    return undefined;
  }
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, ...segments);
  const rel = relative(rootPath, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  try {
    const rootReal = realpathSync(rootPath);
    const candidateReal = realpathSync(candidate);
    const candidateRel = relative(rootReal, candidateReal);
    if (candidateRel === ".." || candidateRel.startsWith(`..${sep}`)) return undefined;
    return candidateReal;
  } catch {
    return undefined;
  }
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

function existingFile(root: string, segments: string[]): string | undefined {
  const filePath = safeExistingPath(root, segments);
  if (!filePath) return undefined;
  try {
    return lstatSync(filePath).isFile() ? filePath : undefined;
  } catch {
    return undefined;
  }
}

function parseNonNegInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function csvEscape(value: unknown): string {
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function mdCell(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_\[\]])/g, "\\$1");
}

function readTailText(filePath: string, collapseNewlines = false): string {
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_LIMIT);
    const buf = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = readSync(fd, buf, bytesRead, length - bytesRead, size - length + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    let start = 0;
    while (start < bytesRead && (buf[start] & 0xc0) === 0x80) start++;
    let text = buf.subarray(start, bytesRead).toString("utf8");
    if (collapseNewlines) text = text.replace(/\r\n?/g, "\n").replace(/\n{2,}/g, "\n");
    return text;
  } finally {
    closeSync(fd);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function lookupTournament(c: Context, dir: string): { tid: string; tournament: Tournament } | Response {
  const tid = c.req.param("tid");
  if (!validSegment(tid)) return invalidPath(c);
  const tournament = getTournament(tid, dir);
  if (!tournament) return c.json({ error: "tournament not found" }, 404);
  return { tid, tournament };
}

function lookupGame(c: Context, dir: string): { tid: string; gid: string; tournament: Tournament; game: Game } | Response {
  const tid = c.req.param("tid");
  const gid = c.req.param("gid");
  if (!validSegment(tid) || !validSegment(gid)) return invalidPath(c);
  const tournament = getTournament(tid, dir);
  if (!tournament) return c.json({ error: "tournament not found" }, 404);
  const game = tournament.games.find(candidate => candidate.id === gid);
  if (!game) return c.json({ error: "game not found" }, 404);
  return { tid, gid, tournament, game };
}

function lookupPlayer(c: Context, dir: string): { tid: string; gid: string; pid: string; tournament: Tournament; game: Game } | Response {
  const tid = c.req.param("tid");
  const gid = c.req.param("gid");
  const pid = c.req.param("pid");
  if (!validSegment(tid) || !validSegment(gid) || !validSegment(pid)) return invalidPath(c);
  const tournament = getTournament(tid, dir);
  if (!tournament) return c.json({ error: "tournament not found" }, 404);
  const game = tournament.games.find(candidate => candidate.id === gid);
  if (!game) return c.json({ error: "game not found" }, 404);
  if (!game.seats.includes(pid)) return c.json({ error: "player not found" }, 404);
  return { tid, gid, pid, tournament, game };
}

function tournamentReport(tournament: Tournament, organizer: boolean): string {
  const standings = computeStandings(tournament);
  const standingHeaders = ["id", "label", "model", "elo", "played", "wins", "losses", "draws", "points", "winRate"] as const;
  const lines: string[] = [
    `# ${mdCell(tournament.name)}`,
    "",
    "## Standings",
    "",
    `| ${standingHeaders.join(" | ")} |`,
    `| ${standingHeaders.map(() => "---").join(" | ")} |`,
  ];
  for (const row of standings) {
    lines.push(`| ${standingHeaders.map(key => mdCell(row[key])).join(" | ")} |`);
  }

  lines.push("", "## Head-to-head", "");
  for (let i = 0; i < tournament.players.length; i++) {
    for (let j = i + 1; j < tournament.players.length; j++) {
      const a = tournament.players[i]!;
      const b = tournament.players[j]!;
      lines.push(`### ${mdCell(a.id)} vs ${mdCell(b.id)}`, "");
      const games = tournament.games.filter(game => {
        const seats = new Set(game.seats);
        return seats.has(a.id) && seats.has(b.id);
      });
      if (!games.length) {
        lines.push("No games.", "");
        continue;
      }
      for (const game of games) {
        const result = game.status !== "done"
          ? game.status
          : game.winner === null
            ? "draw"
            : `${game.winner} won`;
        const reason = game.reason && (organizer || !hideLive() || game.status === "done") ? ` (${mdCell(game.reason)})` : "";
        lines.push(`- ${mdCell(game.id)}: ${mdCell(result)}${reason}`);
      }
      lines.push("");
    }
  }

  lines.push("## Per-game deck choices", "");
  for (const game of tournament.games) {
    lines.push(`### ${mdCell(game.id)}`, "");
    if (!organizer && hideLive() && game.status !== "done") {
      lines.push("Deck choices are private until the game is done.", "");
      continue;
    }
    for (const pid of game.seats) {
      const deck = game.decks?.[pid];
      lines.push(deck ? `- ${mdCell(pid)}: ${mdCell(deck.name)} — ${mdCell(deck.reason)}` : `- ${mdCell(pid)}: (no deck)`);
    }
    lines.push("");
  }

  lines.push("## Deck meta", "");
  lines.push("| name | source | picks | wins | picked by |");
  lines.push("| --- | --- | --- | --- | --- |");
  const decks = new Map<string, { name: string; source: string; picks: number; wins: number; pickedBy: Map<string, number> }>();
  for (const game of tournament.games) {
    if (!organizer && hideLive() && game.status !== "done") continue;
    for (const pid of game.seats) {
      const deck = game.decks?.[pid];
      if (!deck?.name) continue;
      const key = `${deck.source}:${deck.name}`;
      let stat = decks.get(key);
      if (!stat) {
        stat = { name: deck.name, source: deck.source, picks: 0, wins: 0, pickedBy: new Map() };
        decks.set(key, stat);
      }
      stat.picks++;
      if (game.status === "done" && game.winner === pid) stat.wins++;
      stat.pickedBy.set(pid, (stat.pickedBy.get(pid) ?? 0) + 1);
    }
  }
  for (const stat of decks.values()) {
    const pickedBy = [...stat.pickedBy.entries()].map(([id, count]) => `${id}×${count}`).join(", ");
    lines.push(`| ${mdCell(stat.name)} | ${mdCell(stat.source)} | ${stat.picks} | ${stat.wins} | ${mdCell(pickedBy)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Build the read-only tournament API against one storage root. */
export function buildTournamentApi(dir = tournamentDir()): TournamentApiApp {
  const app = new Hono();

  app.use("/api/tournaments/*", async (c, next) => {
    c.header("Vary", "Authorization", { append: true });
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/api/tournaments", (c) => c.json(listTournaments(dir)));

  app.get("/api/tournaments/:tid", (c) => {
    const found = lookupTournament(c, dir);
    if (found instanceof Response) return found;
    const organizer = organizerAuthorized(c);
    const games = found.tournament.games.map(game => {
      if (organizer || !hideLive() || game.status === "done") return game;
      const { decks, reason, error, ...publicGame } = game;
      return { ...publicGame, decks: {} };
    });
    return c.json({ ...found.tournament, games, standings: computeStandings(found.tournament) });
  });

  app.get("/api/tournaments/:tid/games/:gid/replay", (c) => {
    const found = lookupGame(c, dir);
    if (found instanceof Response) return found;
    const filePath = existingFile(dir, [found.tid, "games", found.gid, "replay.jsonl"]);
    if (!filePath) return c.json({ error: "replay not found" }, 404);
    const frames = readJsonLines<{ t: number; msg: unknown }>(filePath);
    const from = parseNonNegInt(c.req.query("from")) ?? 0;
    c.header("X-Frame-Count", String(frames.length));
    return c.json(frames.slice(from));
  });

  app.get("/api/tournaments/:tid/games/:gid/decisions/:pid", (c) => {
    const found = lookupPlayer(c, dir);
    if (found instanceof Response) return found;
    const organizer = organizerAuthorized(c);
    if (!organizer && hideLive() && found.game.status !== "done") return organizerRequired(c);
    const rows = getDecisions(found.tid, found.gid, found.pid, dir);
    const from = parseNonNegInt(c.req.query("from")) ?? 0;
    c.header("X-Row-Count", String(rows.length));
    return c.json(organizer ? rows.slice(from) : publicDecisions(rows.slice(from)));
  });

  app.get("/api/tournaments/:tid/games/:gid/activity/:pid", (c) => {
    const found = lookupPlayer(c, dir);
    if (found instanceof Response) return found;
    if (!organizerAuthorized(c) && hideLive() && found.game.status !== "done") return organizerRequired(c);
    const filePath = existingFile(dir, [found.tid, "games", found.gid, `${found.pid}.tools.jsonl`]);
    const rows = filePath ? readJsonLines<unknown>(filePath) : [];
    const decisions = getDecisions(found.tid, found.gid, found.pid, dir);
    const from = parseNonNegInt(c.req.query("from")) ?? 0;
    c.header("X-Row-Count", String(rows.length));
    return c.json(publicActivity(rows.slice(from), decisions, found.game.decks?.[found.pid]));
  });

  app.get("/api/tournaments/:tid/games/:gid/tools/:pid", (c) => {
    const found = lookupPlayer(c, dir);
    if (found instanceof Response) return found;
    if (!organizerAuthorized(c)) return organizerRequired(c);
    const filePath = existingFile(dir, [found.tid, "games", found.gid, `${found.pid}.tools.jsonl`]);
    const rows = filePath ? readJsonLines<unknown>(filePath) : [];
    const limit = parseNonNegInt(c.req.query("limit"));
    return c.json(limit === undefined ? rows : rows.slice(0, limit));
  });

  app.get("/api/tournaments/:tid/games/:gid/transcript/:pid", (c) => {
    const found = lookupPlayer(c, dir);
    if (found instanceof Response) return found;
    if (!organizerAuthorized(c)) return organizerRequired(c);
    const filePath = existingFile(dir, [found.tid, "games", found.gid, `${found.pid}.transcript.jsonl`]);
    if (!filePath) return c.json({ error: "transcript not found" }, 404);
    try {
      return c.text(readTailText(filePath, true));
    } catch {
      return c.json({ error: "transcript not found" }, 404);
    }
  });

  app.get("/api/tournaments/:tid/games/:gid/stderr/:pid", (c) => {
    const found = lookupPlayer(c, dir);
    if (found instanceof Response) return found;
    if (!organizerAuthorized(c)) return organizerRequired(c);
    const filePath = existingFile(dir, [found.tid, "games", found.gid, `${found.pid}.stderr.log`]);
    if (!filePath) return c.json({ error: "stderr not found" }, 404);
    try {
      return c.text(readTailText(filePath));
    } catch {
      return c.json({ error: "stderr not found" }, 404);
    }
  });

  app.get("/api/leaderboard", (c) => c.json(getLeaderboard(dir)));

  app.get("/api/leaderboard.csv", (c) => {
    const board = getLeaderboard(dir);
    const rows = [
      CSV_COLUMNS.join(","),
      ...board.players.map(player => CSV_COLUMNS.map(column => csvEscape(player[column])).join(",")),
    ];
    c.header("Content-Type", "text/csv; charset=utf-8");
    return c.body(`${rows.join("\n")}\n`);
  });

  app.get("/api/tournaments/:tid/report.md", (c) => {
    const found = lookupTournament(c, dir);
    if (found instanceof Response) return found;
    c.header("Content-Type", "text/markdown; charset=utf-8");
    return c.body(tournamentReport(found.tournament, organizerAuthorized(c)));
  });

  app.get("/api/tournaments/:tid/events", (c) => {
    const found = lookupTournament(c, dir);
    if (found instanceof Response) return found;
    const tid = found.tid;
    const stop = new AbortController();
    const onStop = () => stop.abort();
    const requestSignal = c.req.raw.signal;
    if (requestSignal.aborted) stop.abort();
    else requestSignal.addEventListener("abort", onStop, { once: true });

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    return stream(c, async (out) => {
      out.onAbort(onStop);
      try {
        let lastMtime: number | undefined;
        while (!stop.signal.aborted && !out.aborted) {
          const filePath = existingFile(dir, [tid, "tournament.json"]);
          let mtime: number | undefined;
          try {
            if (filePath) mtime = lstatSync(filePath).mtimeMs;
          } catch {
            mtime = undefined;
          }
          if (mtime !== undefined && mtime !== lastMtime) {
            lastMtime = mtime;
            try {
              await out.write(`event: change\ndata: ${new Date(mtime).toISOString()}\n\n`);
            } catch {
              break;
            }
          }
          if (stop.signal.aborted || out.aborted) break;
          await delay(SSE_POLL_MS, stop.signal);
        }
      } finally {
        requestSignal.removeEventListener("abort", onStop);
      }
    });
  });

  return app;
}

/** Mount tournament routes on an existing server app. */
export function addTournamentRoutes(app: TournamentApiApp, dir = tournamentDir()): void {
  app.route("/", buildTournamentApi(dir));
}
