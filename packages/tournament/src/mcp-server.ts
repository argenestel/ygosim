import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport, type EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Session, type ToolDef, wsUrlFor } from "@ygosim/mcp/tools";
import { fetchSampleDecks, resolveDeck } from "@ygosim/mcp/deck";
import { GameClient } from "@ygosim/mcp/client";
import type { ServerMsg } from "@ygosim/protocol";
import type { Game } from "./types.js";

const BODY_LIMIT = 4 * 1024 * 1024;
const ROOM_WAIT_MS = 60_000;

type PlayerId = string;
type GameStats = Game["stats"][string];
type DeckRecord = Game["decks"][string];

export interface TournamentMcpServerOptions {
  game: Game;
  gameDir: string;
  /** WebSocket or HTTP base URL of the game server. */
  server: string;
  onChange?: (game: Game) => void | Promise<void>;
  /** Optional bind port for tests; defaults to an ephemeral localhost port. */
  port?: number;
}

export interface TournamentMcpServer {
  urlFor(playerId: PlayerId): string;
  sessions: Map<PlayerId, Session>;
  close(): Promise<void>;
}

interface TransportEntry {
  playerId: PlayerId;
  transport: StreamableHTTPServerTransport;
  mcp: McpServer;
}

interface ToolCallRow {
  t: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  ms: number;
  resultPreview: string;
}

interface DecisionRow {
  t: number;
  turn: number;
  phase: string;
  promptId: string;
  promptKind: string;
  options: string[];
  choose: (string | number)[];
  reason: string;
  ms: number;
}

/**
 * A small event store for Streamable HTTP resumability. Each transport keeps
 * its own store, so replaying a disconnected MCP stream cannot cross player
 * or game boundaries.
 */
class MemoryEventStore implements EventStore {
  private readonly events: { id: string; streamId: string; message: JSONRPCMessage }[] = [];

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const id = `${streamId}_${Date.now()}_${randomUUID()}`;
    this.events.push({ id, streamId, message });
    return id;
  }

  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    return this.events.find(event => event.id === eventId)?.streamId;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    const index = this.events.findIndex(event => event.id === lastEventId);
    if (index < 0) return "";
    const streamId = this.events[index]!.streamId;
    for (const event of this.events.slice(index + 1)) {
      if (event.streamId === streamId) await send(event.id, event.message);
    }
    return streamId;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safePlayerFilePart(playerId: string): string {
  return playerId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function bodyJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.length;
      if (size > BODY_LIMIT) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(value);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve(undefined);
      try { resolve(JSON.parse(text)); }
      catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function writeJsonLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function pathParts(req: IncomingMessage): { gameId: string; playerId: string } | undefined {
  let url: URL;
  try { url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`); }
  catch { return undefined; }
  const raw = url.pathname.split("/").filter(Boolean);
  if (raw.length !== 3 || raw[0] !== "mcp") return undefined;
  try {
    const gameId = decodeURIComponent(raw[1]!);
    const playerId = decodeURIComponent(raw[2]!);
    if (!gameId || !playerId || gameId.includes("..") || playerId.includes("..")) return undefined;
    return { gameId, playerId };
  } catch { return undefined; }
}

function copyArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  return structuredClone(args) as Record<string, unknown>;
}

function deckShape() {
  return {
    deck: z.string().min(1).optional().describe("Sample deck name returned by list_decks."),
    ydk: z.string().min(1).optional().describe("Raw .ydk deck text."),
    main: z.array(z.number().int().positive()).optional().describe("Main-deck passcodes."),
    extra: z.array(z.number().int().positive()).optional().describe("Extra-deck passcodes."),
    side: z.array(z.number().int().positive()).optional().describe("Side-deck passcodes."),
  };
}

interface EnterMatchArgs {
  deck?: string;
  ydk?: string;
  main?: number[];
  extra?: number[];
  side?: number[];
  reason: string;
}

interface ActArgs {
  choose: (string | number)[];
  reason: string;
  promptId?: string;
  wait?: boolean;
  timeoutSec?: number;
}

interface DecisionContext {
  turn?: number;
  phase?: string;
  promptId?: string;
  promptKind?: string;
  options?: string[];
  reason: string;
  choose: (string | number)[];
}

/** Create one tournament game’s persistent, per-seat MCP bridge. */
export async function createTournamentMcpServer(options: TournamentMcpServerOptions): Promise<TournamentMcpServer> {
  const { game, gameDir, onChange } = options;
  const gameServer = options.server.replace(/\/+$/, "");
  mkdirSync(gameDir, { recursive: true });

  const sessions = new Map<PlayerId, Session>();
  const playerIds = [...game.seats];
  for (const playerId of playerIds) {
    sessions.set(playerId, new Session({ baseUrl: gameServer, name: `Tournament-${game.id}-${playerId}` }));
    if (!game.stats[playerId]) {
      game.stats[playerId] = { decisions: 0, avgDecisionMs: 0, invalid: 0, toolCalls: 0, resumes: 0, reasonsGiven: 0 };
    }
  }

  const logStart = Date.now();
  const replayPath = join(gameDir, "replay.jsonl");
  const toolPaths = new Map<PlayerId, string>();
  const decisionPaths = new Map<PlayerId, string>();
  for (const playerId of playerIds) {
    const filePart = safePlayerFilePart(playerId);
    toolPaths.set(playerId, join(gameDir, `${filePart}.tools.jsonl`));
    decisionPaths.set(playerId, join(gameDir, `${filePart}.decisions.jsonl`));
    // Keep the storage contract visible even when an agent exits before its
    // first MCP call.
    appendFileSync(toolPaths.get(playerId)!, "");
    appendFileSync(decisionPaths.get(playerId)!, "");
  }
  appendFileSync(replayPath, "");

  const transports = new Map<string, TransportEntry>();
  const spectatorClients = new Set<GameClient>();
  const spectatorSockets = new Set<{ close(): void }>();
  let spectatorTerminal = false;
  let spectatorPromise: Promise<void> | undefined;
  let roomId: string | undefined;
  let closed = false;

  const notifyChange = async () => {
    if (!onChange) return;
    await onChange(game);
  };

  const statsFor = (playerId: PlayerId): GameStats => {
    const current = game.stats[playerId];
    if (current) return current;
    const created = { decisions: 0, avgDecisionMs: 0, invalid: 0, toolCalls: 0, resumes: 0, reasonsGiven: 0 };
    game.stats[playerId] = created;
    return created;
  };

  const logTool = (playerId: PlayerId, row: ToolCallRow) => {
    const path = toolPaths.get(playerId);
    if (path) writeJsonLine(path, row);
  };

  const logDecision = (playerId: PlayerId, row: DecisionRow) => {
    const path = decisionPaths.get(playerId);
    if (path) writeJsonLine(path, row);
  };

  const recordTool = async <T>(
    playerId: PlayerId,
    tool: string,
    args: Record<string, unknown>,
    run: () => Promise<T>,
    decision?: DecisionContext,
  ): Promise<T> => {
    const started = Date.now();
    let ok = false;
    let result: T | undefined;
    let failure: unknown;
    try {
      result = await run();
      ok = typeof result !== 'string' || !/^ERROR from server:/m.test(result);
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const ms = Date.now() - started;
      const stats = statsFor(playerId);
      stats.toolCalls++;
      if (decision) {
        stats.decisions++;
        if (!ok) stats.invalid++;
        stats.avgDecisionMs = stats.decisions === 1
          ? ms
          : ((stats.avgDecisionMs * (stats.decisions - 1)) + ms) / stats.decisions;
        if (decision.reason.trim()) stats.reasonsGiven++;
        logDecision(playerId, {
          t: started - logStart,
          turn: decision.turn ?? 0,
          phase: decision.phase ?? "",
          promptId: decision.promptId ?? "",
          promptKind: decision.promptKind ?? "",
          options: decision.options ?? [],
          choose: decision.choose,
          reason: decision.reason,
          ms,
        });
      }
      const row: ToolCallRow = {
        t: started - logStart,
        tool,
        args: copyArgs(args),
        ok,
        ms,
        resultPreview: "",
      };
      row.resultPreview = (failure ? errorMessage(failure) : String(result ?? '')).slice(0, 200);
      logTool(playerId, row);
      await notifyChange();
    }
  };

  // McpServer validates tool arguments before invoking a registered callback.
  // Observe those raw requests at the transport boundary so malformed calls
  // still appear in the private tool/decision accounting.
  const recordSchemaInvalid = (playerId: PlayerId, tool: string, args: unknown, reason: string): void => {
    const started = Date.now();
    const normalized = copyArgs(args);
    const stats = statsFor(playerId);
    stats.toolCalls++;
    if (tool === "act") {
      stats.decisions++;
      stats.invalid++;
      stats.avgDecisionMs = stats.avgDecisionMs * (stats.decisions - 1) / stats.decisions;
      if (typeof normalized.reason === 'string' && normalized.reason.trim()) stats.reasonsGiven++;
      const session = sessions.get(playerId);
      const prompt = session?.client.prompt;
      const state = session?.client.state;
      logDecision(playerId, {
        t: started - logStart,
        turn: state?.turn ?? 0,
        phase: state?.phase ?? "",
        promptId: prompt?.promptId ?? "",
        promptKind: prompt?.kind ?? "",
        options: prompt?.options.map(option => option.label) ?? [],
        choose: Array.isArray(normalized.choose) ? normalized.choose as (string | number)[] : [],
        reason: typeof normalized.reason === "string" ? normalized.reason : "",
        ms: 0,
      });
    }
    logTool(playerId, {
      t: started - logStart,
      tool,
      args: normalized,
      ok: false,
      ms: 0,
      resultPreview: reason.slice(0, 200),
    });
    void notifyChange();
  };

  const fetchValidation = async (session: Session, deck: { main: number[]; extra: number[]; side: number[] }) => {
    let response: Response;
    try {
      response = await fetch(`${session.http}/api/decks/validate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deck, format: "tcg" }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new Error(`deck validation request failed: ${errorMessage(error)}`);
    }
    let body: any = {};
    try { body = await response.json(); } catch { /* use HTTP status below */ }
    if (!response.ok) throw new Error(`deck validation failed: HTTP ${response.status}`);
    if (!body?.ok) {
      const errors = Array.isArray(body?.errors) ? body.errors.join("; ") : "invalid deck";
      throw new Error(`invalid deck: ${errors}`);
    }
  };

  const findTool = (session: Session, name: string): ToolDef => {
    const tool = session.tools().find(candidate => candidate.name === name);
    if (!tool) throw new Error(`base MCP tool ${name} is unavailable`);
    return tool;
  };

  const attachSpectator = async (newRoomId: string): Promise<void> => {
    if (spectatorPromise) return spectatorPromise;
    spectatorPromise = (async () => {
      const spectator = new GameClient(wsUrlFor(gameServer), `Tournament-${game.id}-spectator`);
      spectatorClients.add(spectator);

      // GameClient creates its WebSocket synchronously before its first await.
      // Install the raw listener as soon as it exists so the welcome frame is
      // included in replay.jsonl too.
      const connecting = spectator.connect();
      while (!spectator.ws) await new Promise<void>(resolve => setImmediate(resolve));
      const socket = spectator.ws;
      spectatorSockets.add(socket);
      socket.on("message", (raw: Buffer | string) => {
        let msg: ServerMsg;
        try { msg = JSON.parse(String(raw)) as ServerMsg; }
        catch { return; }
        if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
        writeJsonLine(replayPath, { t: Date.now() - logStart, msg });
        if (msg.type === "room" && msg.status === "done") spectatorTerminal = true;
        if (msg.type === "events" && msg.events.some(event => event.t === "win")) spectatorTerminal = true;
      });
      await connecting;

      const room = spectator.next(message => message.type === "room" && message.roomId === newRoomId, 10_000);
      spectator.send({ type: "spectate", roomId: newRoomId });
      await room;
    })();
    try {
      await spectatorPromise;
    } catch (error) {
      spectatorPromise = undefined;
      throw error;
    }
  };

  const roomReady = async (): Promise<string> => {
    if (roomId) return roomId;
    const deadline = Date.now() + ROOM_WAIT_MS;
    while (!roomId && !closed && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 20));
    if (closed) throw new Error("tournament MCP server is closed");
    if (!roomId) throw new Error("seat 0 must enter_match first");
    return roomId;
  };

  const enterMatch = async (playerId: PlayerId, args: EnterMatchArgs): Promise<string> => {
    const session = sessions.get(playerId)!;
    if (args.deck === undefined && args.ydk === undefined && args.main === undefined) {
      throw new Error('Choose a deck source: deck, ydk, or main/extra');
    }
    const sampleName = args.deck === undefined ? undefined : (await fetchSampleDecks(session.http))
      .find(deck => deck.name.toLowerCase() === args.deck!.toLowerCase())?.name;
    if (args.deck !== undefined && !sampleName) throw new Error(`Unknown sample deck: ${args.deck}`);
    const deck = await resolveDeck({ sample: args.deck, ydk: args.ydk, main: args.main, extra: args.extra, side: args.side }, session.http);
    await fetchValidation(session, deck);

    const seat = game.seats.indexOf(playerId);
    if (seat < 0) throw new Error("player is not seated in this game");
    const record: DeckRecord = {
      name: sampleName ?? (args.ydk !== undefined ? "Custom YDK" : "Custom deck"),
      source: args.deck !== undefined ? "sample" : "custom",
      reason: args.reason,
      main: [...deck.main],
      extra: [...deck.extra],
    };

    if (seat === 0) {
      // Publish the deck before the room request so a concurrently-started
      // seat 1 can wait for the room without being allowed to join early.
      game.decks[playerId] = record;
      const create = findTool(session, "create_room");
      try {
        await create.run({ vsAI: false, main: deck.main, extra: deck.extra, side: deck.side });
        const createdRoom = session.client.room;
        if (!createdRoom) throw new Error("game server did not return a room");
        await attachSpectator(createdRoom.roomId);
        roomId = createdRoom.roomId;
      } catch (error) {
        delete game.decks[playerId];
        throw error;
      }
      return `Match entered as seat 0 (room ${roomId}). Call wait_for_turn.`;
    }

    const joiningRoom = await roomReady();
    const join = findTool(session, "join_room");
    await join.run({ roomId: joiningRoom, main: deck.main, extra: deck.extra, side: deck.side });
    game.decks[playerId] = record;
    return "Match entered as seat 1. Call wait_for_turn.";
  };

  const registerMcp = (playerId: PlayerId, session: Session) => {
    const base = new Map(session.tools().map(tool => [tool.name, tool] as const));
    const mcp = new McpServer({ name: "ygosim-tournament", version: "0.1.0" });
    const schemas = new Map<string, z.ZodTypeAny>();
    const rememberSchema = (name: string, shape: any) => {
      schemas.set(name, z.object(shape as z.ZodRawShape));
      return shape;
    };
    const run = (name: string, args: Record<string, unknown>) => {
      const tool = base.get(name);
      if (!tool) throw new Error(`base MCP tool ${name} is unavailable`);
      return tool.run(args);
    };

    const listDecksShape = rememberSchema("list_decks", {});
    mcp.registerTool("list_decks", {
      description: "List sample deck names available on the ygosim game server.",
      inputSchema: listDecksShape,
    }, async (args: any) => textResult(await recordTool(playerId, "list_decks", copyArgs(args), async () => {
      const decks = await fetchSampleDecks(session.http);
      return decks.length ? decks.map(deck => deck.name).join("\n") : "(no sample decks)";
    })));

    const cardInfo = base.get("card_info")!;
    const cardInfoShape = rememberSchema("card_info", cardInfo.shape);
    mcp.registerTool("card_info", {
      description: cardInfo.description,
      inputSchema: cardInfoShape,
    }, async (args: any) => textResult(await recordTool(playerId, "card_info", copyArgs(args), () => run("card_info", args))));

    const enterShape = rememberSchema("enter_match", {
      ...deckShape(),
      reason: z.string().trim().min(1).describe("Private strategic reason for choosing this deck."),
    });
    mcp.registerTool("enter_match", {
      description: "Choose and register your deck for this tournament match. The reason is private and is recorded for evaluation.",
      inputSchema: enterShape,
    }, async (args: EnterMatchArgs) => textResult(await recordTool(playerId, "enter_match", copyArgs(args), () => enterMatch(playerId, args))));

    const wait = base.get("wait_for_turn")!;
    const waitShape = rememberSchema("wait_for_turn", wait.shape);
    mcp.registerTool("wait_for_turn", {
      description: wait.description,
      inputSchema: waitShape,
    }, async (args: any) => textResult(await recordTool(playerId, "wait_for_turn", copyArgs(args), () => run("wait_for_turn", args))));

    const state = base.get("get_state")!;
    const stateShape = rememberSchema("get_state", state.shape);
    mcp.registerTool("get_state", {
      description: state.description,
      inputSchema: stateShape,
    }, async (args: any) => textResult(await recordTool(playerId, "get_state", copyArgs(args), () => run("get_state", args))));

    const act = base.get("act")!;
    const actShape: any = rememberSchema("act", {
      ...act.shape,
      reason: z.string().trim().min(1).describe("Private strategic reason for this action."),
    });
    mcp.registerTool("act", {
      description: `${act.description} Every action must include a concise private strategic reason.`,
      inputSchema: actShape,
    }, async (rawArgs: any) => {
      const args = rawArgs as ActArgs;
      const prompt = session.client.prompt;
      const state = session.client.state;
      return textResult(await recordTool(
        playerId,
        "act",
        copyArgs(args),
        () => {
          const { reason: _privateReason, ...actionArgs } = args;
          return run("act", copyArgs(actionArgs));
        },
        {
          turn: state?.turn,
          phase: state?.phase,
          promptId: prompt?.promptId,
          promptKind: prompt?.kind,
          options: prompt?.options.map(option => option.label),
          reason: args.reason,
          choose: Array.isArray(args.choose) ? args.choose : [],
        },
      ));
    });

    const surrender = base.get("surrender")!;
    const surrenderShape = rememberSchema("surrender", surrender.shape);
    mcp.registerTool("surrender", {
      description: surrender.description,
      inputSchema: surrenderShape,
    }, async (args: any) => textResult(await recordTool(playerId, "surrender", copyArgs(args), () => run("surrender", args))));

    return {
      mcp,
      validationError(name: string, args: unknown): string | undefined {
        const schema = schemas.get(name);
        if (!schema) return `unknown tournament tool ${name}`;
        const result = schema.safeParse(args ?? {});
        return result.success ? undefined : result.error.message;
      },
    };
  };

  const httpServer = createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, mcp-session-id, last-event-id");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const parts = pathParts(req);
    if (!parts || parts.gameId !== game.id || !sessions.has(parts.playerId)) {
      jsonRpcError(res, 404, "MCP endpoint not found");
      return;
    }

    void (async () => {
      const sessionId = req.headers["mcp-session-id"];
      const sid = typeof sessionId === "string" ? sessionId : undefined;
      let entry = sid ? transports.get(sid) : undefined;

      if (entry && entry.playerId !== parts.playerId) {
        jsonRpcError(res, 403, "MCP session belongs to another player");
        return;
      }

      let body: unknown;
      if (req.method === "POST") {
        try { body = await bodyJson(req); }
        catch (error) { jsonRpcError(res, 400, errorMessage(error)); return; }
      }

      if (!entry) {
        if (req.method !== "POST" || sid || !isInitializeRequest(body)) {
          jsonRpcError(res, 400, "initialize the MCP session first");
          return;
        }
        const session = sessions.get(parts.playerId)!;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          eventStore: new MemoryEventStore(),
          onsessioninitialized: (newSessionId) => {
            transports.set(newSessionId, entry!);
          },
        });
        const registered = registerMcp(parts.playerId, session);
        entry = { playerId: parts.playerId, transport, mcp: registered.mcp };
        transport.onmessage = (message: any) => {
          if (message?.method !== "tools/call") return;
          const name = message.params?.name;
          if (typeof name !== "string") return;
          const reason = registered.validationError(name, message.params?.arguments ?? {});
          if (reason) recordSchemaInvalid(parts.playerId, name, message.params?.arguments ?? {}, reason);
        };
        transport.onclose = () => {
          const currentId = transport.sessionId;
          if (currentId && transports.get(currentId)?.transport === transport) transports.delete(currentId);
        };
        await registered.mcp.connect(transport);
      }

      await entry.transport.handleRequest(req, res, body);
    })().catch(error => {
      if (!res.headersSent) jsonRpcError(res, 500, errorMessage(error));
      else res.destroy(error instanceof Error ? error : undefined);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const port = options.port ?? 0;
    const onError = (error: Error) => { httpServer.off("listening", onListening); reject(error); };
    const onListening = () => { httpServer.off("error", onError); resolve(); };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, "127.0.0.1");
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("MCP server did not bind to a TCP port");
  const boundPort = address.port;

  const result: TournamentMcpServer = {
    urlFor(playerId: PlayerId) {
      if (!sessions.has(playerId)) throw new Error(`player ${playerId} is not seated in game ${game.id}`);
      return `http://127.0.0.1:${boundPort}/mcp/${encodeURIComponent(game.id)}/${encodeURIComponent(playerId)}`;
    },
    sessions,
    async close() {
      if (closed) return;
      closed = true;
      // Give the spectator socket a short chance to receive the terminal win
      // event before it is closed. Writes are synchronous, so replay.jsonl is
      // complete before close() resolves.
      if (spectatorClients.size && !spectatorTerminal) {
        const deadline = Date.now() + 500;
        while (!spectatorTerminal && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      }
      // Wake any wait_for_turn calls before closing their HTTP transports.
      // GameClient.close() emits the connection-closed signal consumed by the
      // long poll, so close() cannot strand an agent request indefinitely.
      for (const session of sessions.values()) session.client.close();
      await Promise.all([...transports.values()].map(entry => entry.mcp.close().catch(() => undefined)));
      transports.clear();
      for (const socket of spectatorSockets) socket.close();
      spectatorSockets.clear();
      spectatorClients.clear();
      if (httpServer.listening) await new Promise<void>(resolve => httpServer.close(() => resolve()));
    },
  };
  return result;
}
