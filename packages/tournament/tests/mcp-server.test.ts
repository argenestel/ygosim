import { readFileSync, existsSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Game } from '../src/types.js';

const fakeHttp = vi.hoisted(() => ({
  handler: undefined as ((req: any, res: any) => void) | undefined,
  servers: [] as any[],
}));
const fakeMcp = vi.hoisted(() => ({ instances: [] as any[] }));
const fakeTransport = vi.hoisted(() => ({ instances: [] as any[] }));
const fakeSpectator = vi.hoisted(() => ({ instances: [] as any[], order: [] as string[] }));

vi.mock("node:http", () => ({
  createServer: vi.fn((handler: (req: any, res: any) => void) => {
    fakeHttp.handler = handler;
    const listeners = new Map<string, (...args: any[]) => void>();
    const server = {
      listening: false,
      setHeader: vi.fn(),
      once(event: string, callback: (...args: any[]) => void) { listeners.set(event, callback); return server; },
      off(event: string) { listeners.delete(event); return server; },
      listen() { server.listening = true; queueMicrotask(() => listeners.get("listening")?.()); return server; },
      address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43123 }),
      close(callback?: () => void) { server.listening = false; callback?.(); },
    };
    fakeHttp.servers.push(server);
    return server;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class FakeMcpServer {
    tools = new Map<string, { config: any; callback: (args: any) => Promise<any> }>();
    transport: any;
    constructor() { fakeMcp.instances.push(this); }
    registerTool(name: string, config: any, callback: (args: any) => Promise<any>) { this.tools.set(name, { config, callback }); }
    async connect(transport: any) { this.transport = transport; }
    async close() { await this.transport?.close(); }
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class FakeStreamableHTTPServerTransport {
    onmessage: ((message: any) => void) | undefined;
    onclose: (() => void) | undefined;
    sessionId: string | undefined;
    constructor(private readonly options: any) { fakeTransport.instances.push(this); }
    async handleRequest(_req: any, res: any, _body: unknown) {
      this.sessionId ??= `session-${fakeTransport.instances.length}`;
      await this.options.onsessioninitialized?.(this.sessionId);
      res.writeHead?.(200, { "content-type": "application/json" });
      res.end?.(JSON.stringify({ ok: true }));
    }
    async close() { this.onclose?.(); }
  },
}));

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  isInitializeRequest: (value: any) => value?.method === "initialize",
}));

vi.mock("@ygosim/mcp/tools", () => ({
  wsUrlFor: (value: string) => value,
  Session: class FakeSession {
    http = "http://game.test";
    actArgs: any;
    client: any;
    constructor(public cfg: any) {
      this.client = {
        prompt: {
          promptId: "prompt-1",
          kind: "idle",
          text: "Choose",
          options: [{ id: "pass", label: "Pass" }],
        },
        state: { turn: 7, phase: "main1" },
        room: undefined,
        close: vi.fn(),
      };
    }
    tools() {
      return [
        { name: "card_info", description: "card info", shape: {}, run: async () => "card" },
        { name: "create_room", description: "create", shape: {}, run: async () => { this.client.room = { roomId: "room-1" }; return "created"; } },
        { name: "join_room", description: "join", shape: {}, run: async () => {
          fakeSpectator.order.push('join');
          const socket = fakeSpectator.instances[0]?.ws;
          const state = { duelId: 'duel', turn: 1, turnPlayer: 0, phase: 'main1', lp: [8000, 8000], cards: [], chain: [], you: 0 };
          socket?.emit('message', JSON.stringify({ type: 'events', events: [{ t: 'new_turn', turn: 1, turnPlayer: 0 }], state }));
          socket?.emit('message', JSON.stringify({ type: 'events', events: [{ t: 'win', winner: 0, reason: 'test' }], state }));
          socket?.emit('message', JSON.stringify({ type: 'room', roomId: 'room-1', players: ['p0', 'p1'], status: 'done' }));
          return 'joined';
        } },
        { name: "wait_for_turn", description: "wait", shape: {}, run: async () => "waited" },
        { name: "get_state", description: "state", shape: {}, run: async () => "state" },
        { name: "act", description: "act", shape: {}, run: async (args: any) => { this.actArgs = args; this.client.state = { turn: 99, phase: "end" }; return "acted"; } },
        { name: "surrender", description: "surrender", shape: {}, run: async () => "surrendered" },
      ];
    }
  },
}));

vi.mock("@ygosim/mcp/deck", () => ({
  fetchSampleDecks: async () => [{ name: "Starter" }],
  resolveDeck: async () => ({ main: [1], extra: [], side: [] }),
}));

vi.mock("@ygosim/mcp/client", () => ({
  GameClient: class FakeGameClient {
    ws = Object.assign(new EventEmitter(), { close: vi.fn() });
    constructor() { fakeSpectator.instances.push(this); }
    async connect() {}
    next() { return Promise.resolve({ type: "room", roomId: "room-1", players: [], status: "waiting" }); }
    send(message: any) {
      if (message.type === 'spectate') {
        fakeSpectator.order.push('spectate');
        this.ws.emit('message', JSON.stringify({ type: 'room', roomId: 'room-1', players: ['p0'], status: 'waiting' }));
      }
    }
    close() { this.ws.close(); }
  },
}));

import { createTournamentMcpServer } from "../src/mcp-server.js";

function gameFixture(): Game {
  return {
    id: "game-1",
    stage: "round-robin" as const,
    round: 1,
    seats: ["p0", "p1"] as [string, string],
    status: "running" as const,
    winner: null,
    decks: {},
    stats: {},
  };
}

function request(body: unknown, player = "p0") {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> };
  req.method = "POST";
  req.url = `/mcp/game-1/${player}`;
  req.headers = { host: "127.0.0.1:43123" };
  const response = {
    headersSent: false,
    setHeader: vi.fn(),
    writeHead: vi.fn(() => { response.headersSent = true; }),
    end: vi.fn(() => { response.headersSent = true; }),
    destroy: vi.fn(),
  };
  return { req, response, body };
}

async function initialize(player = "p0") {
  const value = request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, player);
  const pending = fakeHttp.handler!(value.req, value.response);
  value.req.emit("data", Buffer.from(JSON.stringify(value.body)));
  value.req.emit("end");
  await new Promise<void>(resolve => setImmediate(resolve));
  await pending;
  return fakeMcp.instances.at(-1)!;
}

function rows(path: string): any[] {
  const text = readFileSync(path, "utf8").trim();
  return text ? text.split("\n").map(line => JSON.parse(line)) : [];
}

describe("tournament MCP private accounting", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    fakeHttp.handler = undefined;
    fakeHttp.servers.length = 0;
    fakeMcp.instances.length = 0;
    fakeTransport.instances.length = 0;
    fakeSpectator.instances.length = 0; fakeSpectator.order.length = 0;
    vi.unstubAllGlobals();
  });

  it("creates persistent sessions and writes complete decision/tool rows", async () => {
    const game = gameFixture();
    const gameDir = join(tmpdir(), `ygosim-mcp-${Date.now()}`);
    dirs.push(gameDir);
    const bridge = await createTournamentMcpServer({ game, gameDir, server: "ws://game.test" });
    expect([...bridge.sessions.keys()]).toEqual(["p0", "p1"]);
    expect(existsSync(join(gameDir, "replay.jsonl"))).toBe(true);
    expect(existsSync(join(gameDir, "p0.tools.jsonl"))).toBe(true);
    expect(existsSync(join(gameDir, "p0.decisions.jsonl"))).toBe(true);

    const mcp = await initialize();
    const result = await mcp.tools.get("act")!.callback({ choose: [1], wait: false, reason: "preserve tempo" });
    expect(result.content[0].text).toBe("acted");
    expect((bridge.sessions.get("p0") as any).actArgs).toEqual({ choose: [1], wait: false });
    expect((game as any).stats.p0).toMatchObject({ decisions: 1, toolCalls: 1, invalid: 0, reasonsGiven: 1, avgDecisionMs: expect.any(Number) });

    const decision = rows(join(gameDir, "p0.decisions.jsonl"))[0];
    expect(decision).toEqual(expect.objectContaining({
      turn: 7, phase: "main1", promptId: "prompt-1", promptKind: "idle",
      options: ["Pass"], choose: [1], reason: "preserve tempo", ms: expect.any(Number),
    }));
    const tool = rows(join(gameDir, "p0.tools.jsonl"))[0];
    expect(tool).toEqual(expect.objectContaining({ tool: "act", ok: true, resultPreview: "acted", args: { choose: [1], wait: false, reason: "preserve tempo" } }));
    await mcp.tools.get('get_state')!.callback({});
    expect(game.stats.p0).toMatchObject({ toolCalls: 2, decisions: 1, reasonsGiven: 1 });
    expect(rows(join(gameDir, 'p0.tools.jsonl'))).toHaveLength(2);
    expect(rows(join(gameDir, 'p0.decisions.jsonl'))).toHaveLength(1);
    await bridge.close();
  });

  it("accounts for schema-invalid actions before the SDK callback runs", async () => {
    const game = gameFixture();
    const gameDir = join(tmpdir(), `ygosim-mcp-${Date.now()}`);
    dirs.push(gameDir);
    const bridge = await createTournamentMcpServer({ game, gameDir, server: "ws://game.test" });
    await initialize();
    const transport = fakeTransport.instances[0];
    transport.onmessage?.({ method: "tools/call", params: { name: "act", arguments: { choose: [1] } } });

    expect((game as any).stats.p0).toMatchObject({ decisions: 1, toolCalls: 1, invalid: 1, reasonsGiven: 0 });
    expect(rows(join(gameDir, "p0.decisions.jsonl"))[0]).toEqual(expect.objectContaining({
      turn: 7, phase: "main1", promptId: "prompt-1", promptKind: "idle", options: ["Pass"],
      choose: [1], reason: "", ms: 0,
    }));
    expect(rows(join(gameDir, "p0.tools.jsonl"))[0]).toEqual(expect.objectContaining({ tool: "act", ok: false, resultPreview: expect.any(String) }));
    await bridge.close();
  });
  it('attaches the spectator before seat 1 joins and records room, snapshots, events and end', async () => {
    const game = gameFixture();
    const gameDir = join(tmpdir(), `ygosim-mcp-replay-${Date.now()}`);
    dirs.push(gameDir);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
    const bridge = await createTournamentMcpServer({ game, gameDir, server: 'ws://game.test' });
    const p0 = await initialize('p0'); const p1 = await initialize('p1');
    await Promise.all([
      p1.tools.get('enter_match')!.callback({ deck: 'Starter', reason: 'seat one private reason' }),
      p0.tools.get('enter_match')!.callback({ deck: 'starter', reason: 'seat zero private reason' }),
    ]);
    expect(fakeSpectator.order).toEqual(['spectate', 'join']);
    const replay = rows(join(gameDir, 'replay.jsonl'));
    expect(replay[0].msg).toMatchObject({ type: 'room', status: 'waiting' });
    expect(replay.find(row => row.msg.type === 'events').msg.state).toMatchObject({ lp: [8000, 8000], cards: [] });
    expect(replay.some(row => row.msg.events?.some((event: any) => event.t === 'win'))).toBe(true);
    expect(replay.at(-1).msg.status).toBe('done');
    expect(JSON.stringify(replay)).not.toContain('private reason');
    expect(game.decks.p0!.reason).toBe('seat zero private reason');
    expect(game.decks.p0!.name).toBe('Starter');
    expect(game.stats.p0).toMatchObject({ toolCalls: 1, decisions: 0, reasonsGiven: 0 });
    const original = bridge.sessions.get('p0');
    game.stats.p0!.resumes = 3;
    await initialize('p0');
    expect(bridge.sessions.get('p0')).toBe(original);
    expect(game.stats.p0!.resumes).toBe(3);
    await bridge.close();
  });
  it('marks server-rejected actions invalid even when Session reports the error as text', async () => {
    const game = gameFixture();
    const gameDir = join(tmpdir(), `ygosim-mcp-error-${Date.now()}`);
    dirs.push(gameDir);
    const bridge = await createTournamentMcpServer({ game, gameDir, server: 'ws://game.test' });
    const session = bridge.sessions.get('p0')!;
    const tools = session.tools();
    session.tools = () => tools.map(tool => tool.name === 'act' ? { ...tool, run: async () => 'ERROR from server: rejected action' } : tool);
    const mcp = await initialize();
    await mcp.tools.get('act')!.callback({ choose: [1], reason: 'tempo' });
    expect(game.stats.p0).toMatchObject({ decisions: 1, invalid: 1, reasonsGiven: 1 });
    expect(rows(join(gameDir, 'p0.tools.jsonl'))[0]).toMatchObject({ ok: false, resultPreview: 'ERROR from server: rejected action' });
    await bridge.close();
  });
  it('rejects unspecified or illegal decks before creating a room and logs the failed calls', async () => {
    const game = gameFixture();
    const gameDir = join(tmpdir(), `ygosim-mcp-deck-${Date.now()}`);
    dirs.push(gameDir);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, errors: ['forbidden card'] }) })));
    const bridge = await createTournamentMcpServer({ game, gameDir, server: 'ws://game.test' });
    const mcp = await initialize();
    await expect(mcp.tools.get('enter_match')!.callback({ reason: 'strategy' })).rejects.toThrow('Choose a deck source');
    await expect(mcp.tools.get('enter_match')!.callback({ deck: 'Starter', reason: 'strategy' })).rejects.toThrow('forbidden card');
    expect(bridge.sessions.get('p0')!.client.room).toBeUndefined();
    expect(game.decks).toEqual({});
    expect(game.stats.p0).toMatchObject({ toolCalls: 2, decisions: 0, invalid: 0, reasonsGiven: 0 });
    expect(rows(join(gameDir, 'p0.tools.jsonl')).every(row => !row.ok)).toBe(true);
    await bridge.close();
  });
});
