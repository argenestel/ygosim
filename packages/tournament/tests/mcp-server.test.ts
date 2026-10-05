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

vi.mock("@ygosim/mcp/deck", async importOriginal => {
  const actual = await importOriginal<typeof import('@ygosim/mcp/deck')>();
  return {
    ...actual,
    fetchSampleDecks: async () => [{ name: "Starter", main: [1], extra: [], side: [] }],
    resolveDeck: async (spec: any) => spec.ydk !== undefined ? actual.parseYdk(spec.ydk) : ({ main: spec.main ?? [1], extra: spec.extra ?? [], side: spec.side ?? [] }),
  };
});

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

async function initialize(bridge: Awaited<ReturnType<typeof createTournamentMcpServer>>, player = "p0") {
  const value = request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, player);
  value.req.headers.authorization = bridge.authorizationFor(player);
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

    const mcp = await initialize(bridge);
    await mcp.tools.get('get_state')!.callback({});
    const result = await mcp.tools.get("act")!.callback({ choose: [1], wait: false, reason: "preserve tempo" });
    expect(result.content[0].text).toBe("acted");
    expect((bridge.sessions.get("p0") as any).actArgs).toEqual({ choose: [1], wait: false });
    expect((game as any).stats.p0).toMatchObject({ decisions: 1, toolCalls: 2, invalid: 0, reasonsGiven: 1, avgDecisionMs: expect.any(Number), timedDecisions: 1, latencyKind: 'response' });

    const decision = rows(join(gameDir, "p0.decisions.jsonl"))[0];
    expect(decision).toEqual(expect.objectContaining({
      turn: 7, phase: "main1", promptId: "prompt-1", promptKind: "idle",
      options: ["Pass"], choose: [1], reason: "preserve tempo", ms: expect.any(Number),
    }));
    const tool = rows(join(gameDir, "p0.tools.jsonl")).find(row => row.tool === 'act');
    expect(tool).toEqual(expect.objectContaining({ tool: "act", ok: true, resultPreview: "acted", args: { choose: [1], wait: false, reason: "preserve tempo" } }));
    await mcp.tools.get('get_state')!.callback({});
    expect(game.stats.p0).toMatchObject({ toolCalls: 3, decisions: 1, reasonsGiven: 1 });
    expect(rows(join(gameDir, 'p0.tools.jsonl'))).toHaveLength(3);
    expect(rows(join(gameDir, 'p0.decisions.jsonl'))).toHaveLength(1);
    await bridge.close();
  });

  it("accounts for schema-invalid actions before the SDK callback runs", async () => {
    const game = gameFixture();
    const gameDir = join(tmpdir(), `ygosim-mcp-${Date.now()}`);
    dirs.push(gameDir);
    const bridge = await createTournamentMcpServer({ game, gameDir, server: "ws://game.test" });
    await initialize(bridge);
    const transport = fakeTransport.instances[0];
    transport.onmessage?.({ method: "tools/call", params: { name: "act", arguments: { choose: [1] } } });

    expect((game as any).stats.p0).toMatchObject({ decisions: 1, toolCalls: 1, invalid: 1, reasonsGiven: 0 });
    expect(rows(join(gameDir, "p0.decisions.jsonl"))[0]).toEqual(expect.objectContaining({
      turn: 7, phase: "main1", promptId: "prompt-1", promptKind: "idle", options: ["Pass"],
      choose: [1], reason: "", toolMs: 0, latencyKind: 'response',
    }));
    expect(rows(join(gameDir, "p0.decisions.jsonl"))[0]).not.toHaveProperty('ms');
    expect(rows(join(gameDir, "p0.tools.jsonl"))[0]).toEqual(expect.objectContaining({ tool: "act", ok: false, resultPreview: expect.any(String) }));
    await bridge.close();
  });
  it('attaches the spectator before seat 1 joins and records room, snapshots, events and end', async () => {
    const game = gameFixture();
    const gameDir = join(tmpdir(), `ygosim-mcp-replay-${Date.now()}`);
    dirs.push(gameDir);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
    const bridge = await createTournamentMcpServer({ game, gameDir, server: 'ws://game.test' });
    const p0 = await initialize(bridge, 'p0'); const p1 = await initialize(bridge, 'p1');
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
    await initialize(bridge, 'p0');
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
    const mcp = await initialize(bridge);
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
    const mcp = await initialize(bridge);
    await expect(mcp.tools.get('enter_match')!.callback({ reason: 'strategy' })).rejects.toThrow('Choose a deck source');
    await expect(mcp.tools.get('enter_match')!.callback({ deck: 'Starter', reason: 'strategy' })).rejects.toThrow('forbidden card');
    expect(bridge.sessions.get('p0')!.client.room).toBeUndefined();
    expect(game.decks).toEqual({});
    expect(game.stats.p0).toMatchObject({ toolCalls: 2, decisions: 0, invalid: 0, reasonsGiven: 0 });
    expect(rows(join(gameDir, 'p0.tools.jsonl')).every(row => !row.ok)).toBe(true);
    await bridge.close();
  });
  it('rejects unauthenticated initialization and another player credential', async () => {
    const gameDir = join(tmpdir(), `ygosim-mcp-auth-${Date.now()}`); dirs.push(gameDir);
    const bridge = await createTournamentMcpServer({ game: gameFixture(), gameDir, server: 'ws://game.test' });
    for (const authorization of [undefined, bridge.authorizationFor('p1')]) {
      const value = request({ method: 'initialize' });
      if (authorization) value.req.headers.authorization = authorization;
      fakeHttp.handler!(value.req, value.response);
      expect(value.response.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    }
    expect(fakeMcp.instances).toHaveLength(0);
    await bridge.close();
  });
  it('separates prompt-response latency from tool execution and subsequent waiting', async () => {
    const gameDir = join(tmpdir(), `ygosim-mcp-timing-${Date.now()}`); dirs.push(gameDir);
    const game = gameFixture();
    const bridge = await createTournamentMcpServer({ game, gameDir, server: 'ws://game.test' });
    const session = bridge.sessions.get('p0')!;
    const tools = session.tools();
    session.tools = () => tools.map(tool => tool.name === 'act' ? { ...tool, run: async args => {
      await new Promise(resolve => setTimeout(resolve, 30)); return tool.run(args);
    } } : tool);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    try {
      const mcp = await initialize(bridge);
      await mcp.tools.get('get_state')!.callback({});
      clock.mockReturnValue(350);
      await mcp.tools.get('act')!.callback({ choose: [1], reason: 'pass' });
      const row = rows(join(gameDir, 'p0.decisions.jsonl'))[0];
      expect(row).toMatchObject({ ms: 250, latencyKind: 'response', optionIds: ['pass'], selected: ['pass'] });
      expect(row.toolMs).toBeGreaterThanOrEqual(20);
      expect(game.stats.p0).toMatchObject({ avgDecisionMs: 250, timedDecisions: 1 });
    } finally { clock.mockRestore(); await bridge.close(); }
  });
  it('redacts credentials before truncating result previews', async () => {
    const gameDir = join(tmpdir(), `ygosim-mcp-preview-${Date.now()}`); dirs.push(gameDir);
    const bridge = await createTournamentMcpServer({ game: gameFixture(), gameDir, server: 'ws://game.test' });
    const credential = bridge.authorizationFor('p0').replace(/^Bearer /, '');
    const session = bridge.sessions.get('p0')!; const tools = session.tools();
    session.tools = () => tools.map(tool => tool.name === 'card_info' ? { ...tool, run: async () => `${'x'.repeat(180)}${credential}` } : tool);
    const mcp = await initialize(bridge);
    await mcp.tools.get('card_info')!.callback({});
    const text = readFileSync(join(gameDir, 'p0.tools.jsonl'), 'utf8');
    expect(text.includes(credential.slice(0, 8))).toBe(false);
    expect(text).toContain('[REDACTED]');
    await bridge.close();
  });
  it('redacts registered provider credentials from saved deck reasons and tool responses', async () => {
    const gameDir = join(tmpdir(), `ygosim-mcp-provider-${Date.now()}`); dirs.push(gameDir);
    const game = gameFixture();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
    const bridge = await createTournamentMcpServer({ game, gameDir, server: 'ws://game.test' });
    bridge.registerRedactor(text => text.replaceAll('synthetic-provider-fixture', '[REDACTED]'));
    const session = bridge.sessions.get('p0')!; const tools = session.tools();
    session.tools = () => tools.map(tool => tool.name === 'card_info' ? { ...tool, run: async () => 'synthetic-provider-fixture' } : tool);
    const mcp = await initialize(bridge);
    expect((await mcp.tools.get('card_info')!.callback({})).content[0].text).toBe('[REDACTED]');
    await mcp.tools.get('enter_match')!.callback({ deck: 'Starter', reason: 'synthetic-provider-fixture' });
    expect(game.decks.p0!.reason).toBe('[REDACTED]');
    expect(readFileSync(join(gameDir, 'p0.tools.jsonl'), 'utf8').includes('synthetic-provider-fixture')).toBe(false);
    await bridge.close();
  });
  it.each([200, 400])('preserves deck validation reasons from HTTP %s and permits a corrected retry', async status => {
    const gameDir = join(tmpdir(), `ygosim-validation-${status}-${Date.now()}`); dirs.push(gameDir);
    const game = gameFixture();
    const errors = ["Main deck must contain 40–60 cards (got 39)", "Forbidden card: Example (12345)", "Unknown passcode: 98765"];
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: status === 200, status, json: async () => ({ ok: false, errors }) })
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetch);
    const bridge = await createTournamentMcpServer({ game, gameDir, server: 'ws://game.test', deckPolicy: 'custom-only' });
    try {
      const mcp = await initialize(bridge);
      const enter = mcp.tools.get('enter_match')!.callback;
      await expect(enter({ main: [2], extra: [], reason: 'build a strategy' })).rejects.toThrow(
        `invalid deck: ${errors.join("\n")}\nFix the reported counts, card passcodes or TCG restrictions and retry enter_match with the corrected deck.`);
      expect(game.decks.p0).toBeUndefined();
      await enter({ main: [2, 3], extra: [], reason: 'corrected strategy' });
      expect(game.decks.p0.main).toEqual([2, 3]);
    } finally { await bridge.close(); }
  });

  it('enforces custom-only decks, hides list_decks and rejects a sample copied as passcodes or YDK', async () => {
    const gameDir = join(tmpdir(), `ygosim-custom-rule-${Date.now()}`); dirs.push(gameDir);
    const game = gameFixture();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
    const bridge = await createTournamentMcpServer({ game, gameDir, server: 'ws://game.test', deckPolicy: 'custom-only' });
    const mcp = await initialize(bridge);
    expect(mcp.tools.has('list_decks')).toBe(false);
    await expect(mcp.tools.get('enter_match')!.callback({ reason: 'missing deck' })).rejects.toThrow('retry enter_match with main/extra (optional side) arrays or ydk text');
    await expect(mcp.tools.get('enter_match')!.callback({ deck: 'Starter', reason: 'copy sample' })).rejects.toThrow('Sample decks are forbidden');
    await expect(mcp.tools.get('enter_match')!.callback({ main: [1], extra: [], side: [9], reason: 'copy with a new side' })).rejects.toThrow('exactly match');
    await expect(mcp.tools.get('enter_match')!.callback({ ydk: '#main\n1\n#extra\n!side\n', reason: 'copy as YDK' })).rejects.toThrow('exactly match');
    expect(game.decks).toEqual({}); expect(bridge.sessions.get('p0')!.client.room).toBeUndefined();
    await mcp.tools.get('enter_match')!.callback({ main: [2, 3], extra: [4], side: [5], reason: 'independent selection' });
    expect(game.decks.p0).toMatchObject({ source: 'custom', main: [2, 3], extra: [4], side: [5], fingerprint: expect.any(String) });
    expect(JSON.parse(readFileSync(join(gameDir, 'p0.deck.json'), 'utf8'))).toMatchObject({ main: [2, 3], extra: [4], side: [5], reason: 'independent selection' });
    expect(readFileSync(join(gameDir, 'p0.deck.ydk'), 'utf8')).toBe('#main\n2\n3\n#extra\n4\n!side\n5\n');
    await bridge.close();
  });
});
