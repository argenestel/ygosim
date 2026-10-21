import { Hono } from "hono";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import { timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { providerInfo, deckTitle } from "@ygosim/tournament/providers";
import { computeStandings } from "@ygosim/tournament/standings";
import {
  getDecisions,
  getLeaderboard,
  getTournament,
  isTournamentActive,
  readTournaments,
  tournamentDir,
} from "@ygosim/tournament/storage";
import type { Game, Standing, Tournament } from "@ygosim/tournament/types";

type TournamentApiApp = Hono;

const API_ENDPOINTS = [
  ["/api/tournaments", "Tournament summaries, progress and leaders"],
  ["/api/tournaments/:tid", "Tournament details and standings"],
  ["/api/tournaments/:tid/games/:gid", "Game details and seated players"],
  ["/api/tournaments/:tid/games/:gid/timeline", "Merged decisions, decks, optional tools and result"],
  ["/api/leaderboard", "All-time scored standings"],
  ["/api/leaderboard.csv", "Standings as CSV"],
  ["/api/tournaments/:tid/report.md", "Tournament report"],
  ["/api/tournaments/:tid/events", "Tournament change notifications (SSE)"],
  ["/api/tournaments/:tid/games/:gid/replay", "Replay frames"],
  ["/api/tournaments/:tid/games/:gid/decisions/:pid", "Low-level seat decisions"],
  ["/api/tournaments/:tid/games/:gid/activity/:pid", "Low-level sanitised seat activity"],
  ["/api/tournaments/:tid/games/:gid/tools/:pid", "Organizer raw tool log"],
  ["/api/tournaments/:tid/games/:gid/transcript/:pid", "Organizer transcript"],
  ["/api/tournaments/:tid/games/:gid/stderr/:pid", "Organizer stderr"],
  ["/api/health", "Server health"],
  ["/api/ready", "Engine and card database readiness"],
  ["/api/tournament-capabilities", "Tournament runner capabilities"],
  ["/api/cards", "Search cards"],
  ["/api/cards/:code", "Card details"],
  ["/api/img/crop/:code", "Cropped card art"],
  ["/api/rooms", "List rooms"],
].map(([path, description]) => ({ method: "GET", path, description }));

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

function readTailText(filePath: string, collapseNewlines = false, limit = TAIL_LIMIT): string {
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, limit);
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

function liveState(filePath: string, startedAt?: string) {
  try {
    const lines = readTailText(filePath, false, 256 * 1024).split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      let frame;
      try { frame = JSON.parse(lines[i]!); } catch { continue; }
      const state = frame?.msg?.state;
      if (!state || !Number.isFinite(state.turn) || typeof state.phase !== "string"
        || ![0, 1].includes(state.turnPlayer) || !Array.isArray(state.lp) || state.lp.length !== 2
        || !state.lp.every((lp: unknown) => typeof lp === "number" && Number.isFinite(lp))) continue;
      const time = typeof frame.time === "string" ? Date.parse(frame.time)
        : typeof frame.t === "string" ? Date.parse(frame.t)
        : typeof frame.t === "number" && Number.isFinite(frame.t) && startedAt ? Date.parse(startedAt) + frame.t : NaN;
      if (!Number.isFinite(time)) continue;
      return { turn: state.turn, phase: state.phase, turnPlayer: state.turnPlayer,
        lp: [state.lp[0], state.lp[1]], at: new Date(time).toISOString() };
    }
  } catch { /* Replay may not exist yet. */ }
  return undefined;
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

function tournamentFacts(tournament: Tournament, dir: string) {
  const active = isTournamentActive(tournament.id, dir);
  const kind = tournament.scored === true ? "scored" : tournament.scored === false ? "validation" : "legacy";
  const state = tournament.status === "done" ? "finished" : active ? "live" : "paused";
  const done = tournament.games.filter(game => game.status === "done").length;
  const standings = computeStandings(tournament);
  const top = standings[0];
  const leader = done && top ? { id: top.id, label: top.label, points: top.points, wins: top.wins, losses: top.losses, draws: top.draws } : null;
  const final = tournament.games.find(game => game.stage === "final" && game.status === "done" && game.winner);
  const champion = state !== "finished" ? null : final?.winner ?? tournament.series?.winner
    ?? (done && top && (!standings[1] || top.points > standings[1].points) ? top.id : null);
  return { name: tournament.name.replace(/ \(unscored validation\)$/, ""), kind, state, active,
    format: tournament.format, progress: { done, total: tournament.games.length,
      live: state === "live" ? tournament.games.filter(game => game.status === "running").length : 0,
      errors: tournament.games.filter(game => game.status === "error").length }, leader, champion,
    players: tournament.players.map(player => ({ ...player, ...providerInfo(player) })) };
}

function durationMs(game: Game): number | undefined {
  const duration = game.startedAt && game.endedAt ? Date.parse(game.endedAt) - Date.parse(game.startedAt) : NaN;
  return Number.isFinite(duration) ? duration : undefined;
}

function visibleGame(game: Game, tid: string, dir: string, organizer: boolean) {
  const duration = durationMs(game);
  const timing = duration === undefined ? {} : { durationMs: duration };
  if (!organizer && hideLive() && game.status !== "done") {
    const { decks, reason, error, live, ...publicGame } = game as Game & { live?: unknown };
    return { ...publicGame, ...timing, decks: {} };
  }
  const decks = Object.fromEntries(Object.entries(game.decks ?? {}).map(([pid, deck]) => [pid, { ...deck, title: deckTitle(deck) }]));
  const filePath = game.status === "running" ? existingFile(dir, [tid, "games", game.id, "replay.jsonl"]) : undefined;
  const live = filePath ? liveState(filePath, game.startedAt) : undefined;
  return { ...game, ...timing, decks, ...(live ? { live } : {}) };
}

const PROMPT_LABELS: Record<string, string> = {
  idle: "Main phase", battle_idle: "Battle phase", select_chain: "Chain response", select_effect_yn: "Activate effect?",
  select_yesno: "Yes / No", select_option: "Choose an effect", select_card: "Select cards", select_position: "Battle position",
  select_place: "Choose a zone", select_tribute: "Choose tributes", select_counter: "Remove counters", select_sum: "Select by level",
  announce: "Declare", rps: "Rock-paper-scissors", first_turn: "Go first?",
};
interface TimelineCursor {
  v: 1; tid: string; gid: string; decisions: [number, number]; tools: [number, number]; decks: [boolean, boolean]; result: boolean; lastAt: number;
  decisionBytes: [number, number]; toolBytes: [number, number];
}
function timelineCursor(value: string | undefined, tid: string, gid: string): TimelineCursor {
  if (value === undefined) return { v: 1, tid, gid, decisions: [0, 0], tools: [0, 0], decks: [false, false], result: false, lastAt: 0, decisionBytes: [0, 0], toolBytes: [0, 0] };
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 4096) throw new Error("invalid cursor");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("invalid cursor");
  const cursor = JSON.parse(decoded.toString("utf8")) as TimelineCursor;
  const offsets = (values: unknown) => Array.isArray(values) && values.length === 2
    && values.every(value => Number.isSafeInteger(value) && value >= 0);
  if (!cursor || cursor.v !== 1 || cursor.tid !== tid || cursor.gid !== gid || !offsets(cursor.decisions) || !offsets(cursor.tools)
    || !offsets(cursor.decisionBytes) || !offsets(cursor.toolBytes)
    || !Array.isArray(cursor.decks) || cursor.decks.length !== 2 || !cursor.decks.every(value => typeof value === "boolean")
    || typeof cursor.result !== "boolean" || !Number.isFinite(cursor.lastAt)) throw new Error("invalid cursor");
  return cursor;
}

/** Keep physical row positions, including malformed or private rows, for polling. */
function timelineRows(filePath: string | undefined): { rows: unknown[]; bytes: number } {
  if (!filePath) return { rows: [], bytes: 0 };
  try {
    const text = readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    const rows: unknown[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (i === lines.length - 1 && !line) break;
      try { rows.push(JSON.parse(line)); }
      catch { if (i < lines.length - 1) rows.push(undefined); }
    }
    return { rows, bytes: Buffer.byteLength(text) };
  } catch { return { rows: [], bytes: 0 }; }
}
function relativeTime(t: unknown, game: Game): number {
  if (typeof t !== "number" || !Number.isFinite(t)) return 0;
  const start = game.startedAt ? Date.parse(game.startedAt) : NaN;
  return t > 1e12 && Number.isFinite(start) ? t - start : t;
}

function gameTimeline(c: Context, dir: string, found: { tid: string; gid: string; game: Game }) {
  const { tid, gid, game } = found;
  if (!organizerAuthorized(c) && hideLive() && game.status !== "done") return organizerRequired(c);
  let cursor: TimelineCursor;
  try { cursor = timelineCursor(c.req.query("cursor"), tid, gid); }
  catch { return c.json({ error: "invalid cursor" }, 400); }
  const events: Record<string, unknown>[] = [];
  let shrunk = false, sourceLastAt = 0;
  const includeTools = c.req.query("include")?.split(",").includes("tools") === true;
  for (const seat of [0, 1] as const) {
    const player = game.seats[seat];
    const decisionFile = timelineRows(existingFile(dir, [tid, "games", gid, `${player}.decisions.jsonl`]));
    const toolFile = timelineRows(existingFile(dir, [tid, "games", gid, `${player}.tools.jsonl`]));
    const decisions = decisionFile.rows, tools = toolFile.rows;
    if (cursor.decisions[seat] > decisions.length || decisionFile.bytes < cursor.decisionBytes[seat]) { cursor.decisions[seat] = 0; shrunk = true; }
    if (cursor.tools[seat] > tools.length || toolFile.bytes < cursor.toolBytes[seat]) { cursor.tools[seat] = 0; shrunk = true; }
    cursor.decisionBytes[seat] = decisionFile.bytes;
    // Only advance tool metadata when tools are served; an omitted include must not hide a restart.
    if (includeTools) cursor.toolBytes[seat] = toolFile.bytes;
    const deck = game.decks?.[player];
    const safeDecisions = publicDecisions(decisions);
    const activity = publicActivity(tools.slice(0, includeTools ? tools.length : cursor.tools[seat]), safeDecisions, deck);
    for (const row of [...safeDecisions, ...activity]) sourceLastAt = Math.max(sourceLastAt, relativeTime(row.t, game));
    const enter = deck ? tools.find(row => row && typeof row === "object" && (row as Record<string, unknown>).tool === "enter_match"
        && (row as Record<string, unknown>).ok === true) as Record<string, unknown> | undefined : undefined;
    if (deck) sourceLastAt = Math.max(sourceLastAt, relativeTime(enter?.t, game));
    if (deck && !cursor.decks[seat]) {
      const title = deckTitle(deck);
      events.push({ type: "deck", at: relativeTime(enter?.t, game), seat, player,
        title: safeDecisionText(title) ? title : "Deck", size: { main: deck.main.length, extra: deck.extra.length, side: deck.side?.length ?? 0 },
        reason: safeDecisionText(deck.reason) ? deck.reason : "" });
      cursor.decks[seat] = true;
    }
    for (const row of publicDecisions(decisions.slice(cursor.decisions[seat]))) {
      // A private-only or incomplete row has no public decision to describe.
      if (typeof row.t !== "number") continue;
      const options = Array.isArray(row.options) ? row.options : [];
      const ids = Array.isArray(row.optionIds) ? row.optionIds : [];
      const choices = Array.isArray(row.choose) ? row.choose : [];
      const kind = typeof row.promptKind === "string" ? row.promptKind : "unknown";
      events.push({ type: "decision", at: relativeTime(row.t, game), seat, player,
        ...(row.turn === undefined ? {} : { turn: row.turn }), ...(row.phase === undefined ? {} : { phase: row.phase }),
        prompt: { kind, label: Object.hasOwn(PROMPT_LABELS, kind) ? PROMPT_LABELS[kind] : kind.replaceAll("_", " ") },
        choice: choices.length ? choices.map(choice => {
          const index = typeof choice === "number" ? choice - 1 : ids.indexOf(choice);
          return String(options[index] ?? choice);
        }) : ["Pass"], ...(row.reason === undefined ? {} : { reason: row.reason }), ...(row.ms === undefined ? {} : { thinkMs: row.ms }) });
    }
    cursor.decisions[seat] = decisions.length;
    if (includeTools) {
      for (const row of publicActivity(tools.slice(cursor.tools[seat]), safeDecisions, deck)) {
        const { t, ...activity } = row;
        events.push({ type: "tool", at: relativeTime(t, game), seat, player, ...activity });
      }
      cursor.tools[seat] = tools.length;
    }
  }
  events.sort((a, b) => Number(a.at) - Number(b.at) || Number(a.seat ?? 2) - Number(b.seat ?? 2));
  cursor.lastAt = shrunk ? sourceLastAt : Math.max(cursor.lastAt, sourceLastAt);
  if (game.status === "done" && !cursor.result) {
    events.push({ type: "result", at: durationMs(game) ?? cursor.lastAt, winner: game.winner,
      reason: safeDecisionText(game.reason) ? game.reason : "", ...(game.lp ? { lp: game.lp } : {}), ...(game.turns === undefined ? {} : { turns: game.turns }) });
    cursor.result = true;
    cursor.lastAt = Math.max(cursor.lastAt, durationMs(game) ?? cursor.lastAt);
    events.sort((a, b) => Number(a.at) - Number(b.at) || Number(a.seat ?? 2) - Number(b.seat ?? 2));
  }
  return c.json({ events, cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url"), final: game.status !== "running" && game.status !== "pending" });
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

  app.get("/api", c => c.json({ name: "ygosim API", endpoints: API_ENDPOINTS }));

  app.get("/api/tournaments", c => c.json(readTournaments(dir).map(tournament => {
    const facts = tournamentFacts(tournament, dir);
    return { id: tournament.id, createdAt: tournament.createdAt, status: tournament.status, paused: tournament.paused === true,
      ...facts, done: facts.progress.done, total: facts.progress.total };
  })));

  app.get("/api/tournaments/:tid", c => {
    const found = lookupTournament(c, dir);
    if (found instanceof Response) return found;
    return c.json({ ...found.tournament, ...tournamentFacts(found.tournament, dir),
      games: found.tournament.games.map(game => visibleGame(game, found.tid, dir, organizerAuthorized(c))),
      standings: computeStandings(found.tournament) });
  });

  app.get("/api/tournaments/:tid/games/:gid", c => {
    const found = lookupGame(c, dir);
    if (found instanceof Response) return found;
    const { name, kind, state, format, players } = tournamentFacts(found.tournament, dir);
    const { maxMinutes, onTimeout } = found.tournament.audit ?? {};
    return c.json({ tournament: { id: found.tid, name, kind, state, format,
      ...(maxMinutes === undefined ? {} : { maxMinutes }), ...(onTimeout === undefined ? {} : { onTimeout }) },
      players: found.game.seats.map(id => players.find(player => player.id === id)),
      game: visibleGame(found.game, found.tid, dir, organizerAuthorized(c)) });
  });

  app.get("/api/tournaments/:tid/games/:gid/timeline", c => {
    const found = lookupGame(c, dir);
    return found instanceof Response ? found : gameTimeline(c, dir, found);
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

  app.get("/api/leaderboard", c => {
    const board = getLeaderboard(dir);
    return c.json({ ...board, players: board.players.map(player => ({ ...player, ...providerInfo(player) })) });
  });

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
