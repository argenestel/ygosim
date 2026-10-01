import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { CardDb, ServerMsg } from "@ygosim/protocol";
import { Lobby } from "./lobby.js";
import { sampleDecks, validateDeck } from "./decks.js";
import { loadEngine, parseYdkLocal, type EngineApi } from "./engine.js";
import type { CreateDuel, RoomOptions } from "./room.js";

export interface ServerOptions extends RoomOptions {
  port?: number;
  engine?: EngineApi | null;
  db?: CardDb | null;
  createDuel?: CreateDuel;
}

export function buildApi(lobby: Lobby, getDb: () => CardDb | null, parse = parseYdkLocal) {
  const app = new Hono();
  app.use("/api/*", cors());
  app.get("/api/health", (c) => c.json({ ok: true, db: !!getDb() }));
  app.get("/api/cards/:code", (c) => {
    const db = getDb();
    if (!db) return c.json({ error: "card db not loaded" }, 503);
    const card = db.get(Number(c.req.param("code")));
    return card ? c.json(card) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/cards", (c) => {
    const db = getDb();
    if (!db) return c.json({ error: "card db not loaded" }, 503);
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    return c.json(db.search({ name: c.req.query("q") ?? undefined, type: c.req.query("type") ?? undefined, limit }));
  });
  app.get("/api/rooms", (c) => c.json(lobby.list()));
  app.get("/api/decks", (c) => c.json(sampleDecks(parse)));
  app.post("/api/decks/validate", async (c) => {
    const ct = c.req.header("content-type") ?? "";
    let deck: unknown;
    try {
      if (ct.includes("json")) {
        const body = await c.req.json();
        deck = typeof body?.ydk === "string" ? parse(body.ydk) : (body?.deck ?? body);
      } else deck = parse(await c.req.text());
    } catch { return c.json({ ok: false, errors: ["unparseable body"] }, 400); }
    return c.json({ ...validateDeck(deck, getDb()), deck });
  });
  return app;
}

export async function startServer(opts: ServerOptions = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 7777);
  const engine = opts.engine !== undefined ? opts.engine : await loadEngine();
  let db: CardDb | null = opts.db ?? null;
  if (!db && engine) engine.loadCardDb().then((d) => (db = d), (e) => console.warn("[server] card db failed:", e));
  const createDuel: CreateDuel = opts.createDuel ?? (async (o) => {
    if (!engine) throw new Error("engine not available");
    return engine.createDuel(o);
  });
  const parse = engine?.parseYdk ?? parseYdkLocal;
  const lobby = new Lobby(createDuel, {
    turnTimeoutMs: opts.turnTimeoutMs ?? Number(process.env.TURN_TIMEOUT_MS ?? 180_000),
    botDelayMs: opts.botDelayMs ?? Number(process.env.BOT_DELAY_MS ?? 300),
    maxInvalid: opts.maxInvalid,
  });
  const app = buildApi(lobby, () => db, parse);
  const http = serve({ fetch: app.fetch, port });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req: IncomingMessage, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws: WebSocket) => {
    const send = (m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
    const session = lobby.connect(send);
    ws.on("message", (data) => {
      let msg: unknown;
      try { msg = JSON.parse(String(data)); } catch { return send({ type: "error", message: "invalid JSON" }); }
      try { lobby.handle(session, msg); } catch (e) { send({ type: "error", message: (e as Error).message }); }
    });
    ws.on("close", () => lobby.disconnect(session));
  });
  await new Promise<void>((r) => (http.listening ? r() : http.once("listening", () => r())));
  const addr = http.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    port: actualPort, lobby, app,
    close: () => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(); http.close(() => r()); }),
  };
}
