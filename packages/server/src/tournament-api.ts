import { Hono } from "hono";
import type { Context } from "hono";
import { computeStandings } from "@ygosim/tournament/standings";
import {
  getDecisions,
  getLeaderboard,
  getReplay,
  getTournament,
  listTournaments,
  tournamentDir,
} from "@ygosim/tournament/storage";

type TournamentApiApp = Hono;

function validSegment(value: string): boolean {
  return /^(?:[A-Za-z0-9][A-Za-z0-9_-]*)$/.test(value);
}

function invalidPath(c: Context) {
  return c.json({ error: "invalid path" }, 400);
}

/** Build the read-only tournament API against one storage root. */
export function buildTournamentApi(dir = tournamentDir()): TournamentApiApp {
  const app = new Hono();

  app.get("/api/tournaments", (c) => c.json(listTournaments(dir)));

  app.get("/api/tournaments/:tid", (c) => {
    const tid = c.req.param("tid");
    if (!validSegment(tid)) return invalidPath(c);
    const tournament = getTournament(tid, dir);
    if (!tournament) return c.json({ error: "tournament not found" }, 404);
    return c.json({ ...tournament, standings: computeStandings(tournament) });
  });

  app.get("/api/tournaments/:tid/games/:gid/replay", (c) => {
    const tid = c.req.param("tid");
    const gid = c.req.param("gid");
    if (!validSegment(tid) || !validSegment(gid)) return invalidPath(c);
    const tournament = getTournament(tid, dir);
    if (!tournament) return c.json({ error: "tournament not found" }, 404);
    if (!tournament.games.some(game => game.id === gid)) return c.json({ error: "game not found" }, 404);
    return c.json(getReplay(tid, gid, dir));
  });

  app.get("/api/tournaments/:tid/games/:gid/decisions/:pid", (c) => {
    const tid = c.req.param("tid");
    const gid = c.req.param("gid");
    const pid = c.req.param("pid");
    if (!validSegment(tid) || !validSegment(gid) || !validSegment(pid)) return invalidPath(c);
    const tournament = getTournament(tid, dir);
    if (!tournament) return c.json({ error: "tournament not found" }, 404);
    const game = tournament.games.find(candidate => candidate.id === gid);
    if (!game) return c.json({ error: "game not found" }, 404);
    if (!game.seats.includes(pid)) return c.json({ error: "player not found" }, 404);
    return c.json(getDecisions(tid, gid, pid, dir));
  });

  app.get("/api/leaderboard", (c) => c.json(getLeaderboard(dir)));
  return app;
}

/** Mount tournament routes on an existing server app. */
export function addTournamentRoutes(app: TournamentApiApp, dir = tournamentDir()): void {
  app.route("/", buildTournamentApi(dir));
}
