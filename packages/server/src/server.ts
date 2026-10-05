import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import type { CardDb, ServerMsg, FormatId } from "@ygosim/protocol";
import { Lobby } from "./lobby.js";
import { sampleDecks, validateDeck } from "./decks.js";
import { loadEngine, parseYdkLocal, defaultFormats, type EngineApi } from "./engine.js";
import { abortImageDownloads, ensureImgDir, getImageBuffer } from "./image-cache.js";
import { getAgentInfo, launchAgent, stopAgent, stopRoomAgents } from "./agents.js";
import type { CreateDuel, RoomOptions } from "./room.js";
import { addTournamentRoutes } from "./tournament-api.js";
import { tournamentDir } from "@ygosim/tournament/storage";

export interface ServerOptions extends RoomOptions {
  port?: number;
  engine?: EngineApi | null;
  db?: CardDb | null;
  createDuel?: CreateDuel;
  maxRooms?: number;
  maxConnections?: number;
  maxPayloadBytes?: number;
  messagesPerSecond?: number;
  messageBurst?: number;
  tournamentDir?: string;
}

export function buildApi(
  lobby: Lobby,
  getDb: () => CardDb | null,
  getEngine: () => EngineApi | null,
  getDbReady: () => Promise<CardDb | null>,
  parse = parseYdkLocal,
  getPort = () => Number(process.env.PORT ?? 7777),
  tournamentsRoot = tournamentDir(),
) {
  const app = new Hono();
  app.use("/api/*", bodyLimit({ maxSize: 64 * 1024 }));
  app.use("/api/*", cors({ exposeHeaders: ["X-Frame-Count", "X-Row-Count"] }));

  app.get("/api/health", (c) => c.json({ ok: true, db: !!getDb() }));
  app.get("/api/ready", (c) => {
    const ready = !!getEngine() && !!getDb();
    return c.json({ ready }, ready ? 200 : 503);
  });
  app.get("/api/tournament-capabilities", (c) => c.json({ version: 1, adjudication: true, decisionPolicy: "forfeit", seededGames: true, ...lobby.tournamentLimits }));
  app.use("/api/agents/*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const peer = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket.remoteAddress;
    const origin = c.req.header("origin");
    let localOrigin = !origin;
    if (origin) {
      try { localOrigin = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname); }
      catch { localOrigin = false; }
    }
    if (process.env.YGOSIM_ALLOW_AGENT_LAUNCH !== "1" || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "")
      || c.req.header("x-forwarded-for") || !localOrigin) {
      return c.json({ ok: false, error: "Agent control is restricted to explicitly enabled local requests" }, 403);
    }
    return next();
  });

  app.get("/api/cards/:code", async (c) => {
    const db = getDb() ?? await getDbReady();
    if (!db) return c.json({ error: "card db not loaded" }, 503);
    const card = db.get(Number(c.req.param("code")));
    return card ? c.json(card) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/cards", async (c) => {
    const db = getDb() ?? await getDbReady();
    if (!db) return c.json({ error: "card db not loaded", total: 0, cards: [] }, 503);

    const query = c.req.query("q") ?? "";
    const kind = c.req.query("kind");
    const attribute = c.req.query("attribute");
    const race = c.req.query("race");
    const level = c.req.query("level");
    const sort = c.req.query("sort") ?? "name";
    const limit = Math.max(1, Math.min(Math.floor(Number(c.req.query("limit") ?? 50)) || 50, 200));
    const offset = Math.max(Math.floor(Number(c.req.query("offset") ?? 0)) || 0, 0);

    // Search for cards
    const needle = query.toLowerCase();
    let cards = db.search({ type: kind, limit: Number.MAX_SAFE_INTEGER })
      .filter(card => card.name.toLowerCase().includes(needle) || card.desc.toLowerCase().includes(needle));

    // Filter by additional criteria
    cards = cards.filter(card => {
      if (attribute && card.attribute !== attribute) return false;
      if (race && card.race !== race) return false;
      if (level !== undefined) {
        const cardLevel = Number(level);
        if (!Number.isNaN(cardLevel) && card.level !== cardLevel) return false;
      }
      return true;
    });

    // Sort by requested field
    if (sort === "atk" && cards.length > 0) {
      cards.sort((a, b) => (b.atk ?? 0) - (a.atk ?? 0));
    } else if (sort === "level" && cards.length > 0) {
      cards.sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
    } else {
      cards.sort((a, b) => a.name.localeCompare(b.name));
    }

    const total = cards.length;
    return c.json({
      total,
      cards: cards.slice(offset, offset + limit)
    });
  });

  app.get("/api/img/:code", async (c) => {
    const code = Number(c.req.param("code"));
    if (!Number.isInteger(code) || code <= 0) return c.json({ error: "invalid code" }, 400);
    const buffer = await getImageBuffer(code, "full");
    if (!buffer) return c.json({ error: "image not found" }, 404);
    return c.newResponse(new Uint8Array(buffer), 200, {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
    });
  });

  app.get("/api/img/small/:code", async (c) => {
    const code = Number(c.req.param("code"));
    if (!Number.isInteger(code) || code <= 0) return c.json({ error: "invalid code" }, 400);
    const buffer = await getImageBuffer(code, "small");
    if (!buffer) return c.json({ error: "image not found" }, 404);
    return c.newResponse(new Uint8Array(buffer), 200, {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
    });
  });

  app.get("/api/formats", async (c) => {
    const engine = getEngine();
    if (engine) {
      try {
        const formats = await engine.listFormats();
        return c.json(formats);
      } catch (e) {
        console.warn("[api] listFormats failed:", e);
      }
    }
    return c.json(defaultFormats);
  });

  app.get("/api/banlist/:format", async (c) => {
    const format = c.req.param("format") as FormatId;
    const engine = getEngine();
    if (!engine) return c.json({ error: "engine not available" }, 503);
    try {
      const banlist = await engine.getBanlist(format);
      return banlist ? c.json(Object.fromEntries(banlist)) : c.json({ error: "format not found" }, 404);
    } catch (e) {
      console.warn("[api] getBanlist failed:", e);
      return c.json({ error: "banlist unavailable" }, 503);
    }
  });

  app.get("/api/rooms", (c) => c.json(lobby.list()));

  app.get("/api/decks", (c) => c.json(sampleDecks(parse)));

  app.post("/api/decks/validate", async (c) => {
    const ct = c.req.header("content-type") ?? "";
    let deck: unknown, format: FormatId = "tcg";
    try {
      if (ct.includes("json")) {
        const body = await c.req.json();
        deck = typeof body?.ydk === "string" ? parse(body.ydk) : (body?.deck ?? body);
        format = body?.format ?? "tcg";
      } else {
        deck = parse(await c.req.text());
      }
    } catch {
      return c.json({ ok: false, errors: ["unparseable body"], format }, 400);
    }
    const engine = getEngine();
    if (engine) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Wait for database to be ready before validating
        const db = getDb() ?? await Promise.race([
          getDbReady(),
          new Promise<null>((_, reject) => (timer = setTimeout(() => reject(new Error("database load timeout")), 10000))),
        ]);
        if (!db) {
          return c.json({ ok: false, errors: ["card database unavailable"], format }, 503);
        }
        const result = await engine.validateDeck(deck as any, format, db);
        return c.json({ ...result, deck, format });
      } catch (e) {
        console.warn("[api] engine validateDeck failed:", e);
        return c.json({ ok: false, errors: [`validation error: ${(e as Error).message}`], format }, 503);
      } finally {
        clearTimeout(timer);
      }
    }
    return c.json({ ...validateDeck(deck, getDb()), deck, format });
  });

  app.get("/api/agents", (c) => {
    try {
      const mpcPath = fileURLToPath(new URL("../../mcp/dist/index.js", import.meta.url));
      const agents = getAgentInfo(mpcPath, getPort());
      return c.json(agents);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  app.post("/api/agents/launch", async (c) => {
    // Check for localhost and environment flag
    if (process.env.YGOSIM_ALLOW_AGENT_LAUNCH !== "1") {
      return c.json({ ok: false, error: "Agent launch disabled" }, 403);
    }
    try {
      const body = await c.req.json() as any;
      if (!["claude", "codex"].includes(body?.agent) || typeof body.roomId !== "string" || !lobby.rooms.has(body.roomId)
        || body.seat !== undefined && body.seat !== 0 && body.seat !== 1) return c.json({ ok: false, error: "invalid agent request" }, 400);
      const mpcPath = fileURLToPath(new URL("../../mcp/dist/index.js", import.meta.url));
      const result = await launchAgent(mpcPath, body.agent, body.roomId, body.seat ?? 1, getPort());
      return c.json(result);
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
  });

  app.post("/api/agents/stop", async (c) => {
    try {
      const body = await c.req.json() as any;
      if (typeof body?.roomId !== "string" || body.seat !== undefined && body.seat !== 0 && body.seat !== 1)
        return c.json({ ok: false, error: "invalid agent request" }, 400);
      stopAgent(body.roomId, body.seat ?? 1);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
  });

  app.post("/api/cards/resolve", async (c) => {
    const db = getDb() ?? await getDbReady();
    if (!db) return c.json({ codes: [] }, 503);

    try {
      const body = await c.req.json() as any;
      if (!Array.isArray(body?.names) || body.names.length > 100 || body.names.some((name: unknown) => typeof name !== "string" || name.length > 200))
        return c.json({ error: "names must contain at most 100 strings of at most 200 characters" }, 400);
      const names: string[] = body.names;

      const codes = names.map((name: string) => {
        const exact = db.search({ name, limit: 1 });
        if (exact.length > 0) return exact[0].code;

        // Fuzzy match: search all cards and find best match
        const allCards = db.search({ limit: 9999 });
        const lowerName = name.toLowerCase();
        const matches = allCards.filter(card =>
          card.name.toLowerCase().includes(lowerName)
        );
        return matches.length > 0 ? matches[0].code : null;
      });

      return c.json({ codes });
    } catch (e) {
      return c.json({ codes: [] }, 400);
    }
  });

  // Add tournament routes
  addTournamentRoutes(app, tournamentsRoot);

  return app;
}

export async function startServer(opts: ServerOptions = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 7777);
  const engine = opts.engine !== undefined ? opts.engine : await loadEngine();
  let db: CardDb | null = opts.db ?? null;

  // Keep the database loading promise so we can await it when needed
  let dbReady: Promise<CardDb | null>;
  if (!db && engine) {
    dbReady = engine.loadCardDb().catch((e) => {
      console.warn("[server] card db failed:", e);
      return null;
    }).then((d) => {
      db = d;
      return d;
    });
  } else {
    dbReady = Promise.resolve(db);
  }

  const createDuel: CreateDuel = opts.createDuel ?? (async (o) => {
    if (!engine) throw new Error("engine not available");
    return engine.createDuel(o);
  });
  const parse = engine?.parseYdk ?? parseYdkLocal;
  const getDb = () => db;
  const getEngine = () => engine;
  const getDbReady = () => dbReady;

  const lobby = new Lobby(createDuel, {
    turnTimeoutMs: opts.turnTimeoutMs ?? Number(process.env.TURN_TIMEOUT_MS ?? 180_000),
    botDelayMs: opts.botDelayMs ?? Number(process.env.BOT_DELAY_MS ?? 300),
    maxInvalid: opts.maxInvalid ?? 5,
    seed: opts.seed,
    botRepeatLimit: opts.botRepeatLimit ?? 12,
    botDecisionLimit: opts.botDecisionLimit ?? 512,
  }, undefined, getEngine, getDbReady, opts.maxRooms ?? 100);

  let actualPort = port;
  const app = buildApi(lobby, getDb, getEngine, getDbReady, parse, () => actualPort, opts.tournamentDir ?? tournamentDir());

  // Ensure image cache directory exists
  await ensureImgDir().catch((e) => console.warn("[server] failed to create image cache dir:", e));

  const http = serve({ fetch: app.fetch, port });
  const maxConnections = opts.maxConnections ?? 200;
  const messagesPerSecond = opts.messagesPerSecond ?? 30;
  const messageBurst = opts.messageBurst ?? opts.messagesPerSecond ?? 256;
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayloadBytes ?? 64 * 1024 });
  http.on("upgrade", (req: IncomingMessage, socket, head) => {
    let path: string;
    try { path = new URL(req.url ?? "/", "http://x").pathname; }
    catch { return socket.destroy(); }
    if (path !== "/ws") return socket.destroy();
    if (wss.clients.size >= maxConnections) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws: WebSocket) => {
    const send = (m: ServerMsg) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > 512 * 1024) { ws.close(1008, "client cannot keep up with duel updates"); return; }
      ws.send(JSON.stringify(m));
    };
    const session = lobby.connect(send);
    let refillAt = performance.now();
    let tokens = messageBurst;
    ws.on("error", () => ws.terminate());
    ws.on("message", (data) => {
      const now = performance.now();
      tokens = Math.min(messageBurst, tokens + (now - refillAt) * messagesPerSecond / 1000);
      refillAt = now;
      if (tokens < 1) { ws.close(1008, "message rate limit exceeded"); return; }
      tokens--;
      let msg: unknown;
      try { msg = JSON.parse(String(data)); } catch { return send({ type: "error", message: "invalid JSON" }); }
      try { void lobby.handle(session, msg).catch((e) => send({ type: "error", message: (e as Error).message })); } catch (e) { send({ type: "error", message: (e as Error).message }); }
    });
    ws.on("close", () => lobby.disconnect(session));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      http.off("listening", onListening);
      wss.close();
      reject(error);
    };
    const onListening = () => {
      http.off("error", onError);
      resolve();
    };
    if (http.listening) resolve();
    else {
      http.once("error", onError);
      http.once("listening", onListening);
    }
  });
  const addr = http.address();
  actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    port: actualPort, lobby, app,
    close: async () => {
      abortImageDownloads();
      const roomsClosed = Promise.all([...lobby.rooms.values()].map(room => room.close()));
      for (const room of lobby.rooms.values()) stopRoomAgents(room.id);
      for (const client of wss.clients) client.terminate();
      await Promise.all([
        roomsClosed,
        new Promise<void>(resolve => wss.close(() => resolve())),
        new Promise<void>((resolve, reject) => {
          http.close(error => error ? reject(error) : resolve());
          if ("closeAllConnections" in http) http.closeAllConnections();
        }),
      ]);
    },
  };
}
