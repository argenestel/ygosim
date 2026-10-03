import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createConnection } from "node:net";
import type { Deck, ServerMsg } from "@ygosim/protocol";
import { Lobby } from "../src/lobby.js";
import { MockDuel } from "../src/mock.js";
import { Room, type Participant } from "../src/room.js";
import { buildApi, startServer } from "../src/server.js";

const deck: Deck = { main: Array.from({ length: 40 }, (_, i) => 1000000 + i), extra: [], side: [] };
const factory = async () => new MockDuel([deck, deck]);

describe("production request boundaries", () => {
  it("rejects malformed action, opponent, chat and deck payloads without throwing", async () => {
    const lobby = new Lobby(factory);
    const messages: ServerMsg[] = [];
    const session = lobby.connect(msg => messages.push(msg));
    for (const msg of [{ type: "action" }, { type: "chat", text: {} }, { type: "create_room", deck, opponent: null },
      { type: "create_room", deck, aiLevel: "unknown" }, { type: "create_room", deck: { ...deck, main: [1.5] } }]) {
      await expect(lobby.handle(session, msg)).resolves.toBeUndefined();
    }
    expect(messages.filter(msg => msg.type === "error")).toHaveLength(5);
    expect(lobby.rooms.size).toBe(0);
  });

  it("caps rooms and reclaims disconnected completed rooms", async () => {
    const lobby = new Lobby(factory, {}, undefined, undefined, undefined, 1);
    const first = lobby.connect(() => {});
    const messages: ServerMsg[] = [];
    const second = lobby.connect(msg => messages.push(msg));
    await lobby.handle(first, { type: "create_room", deck });
    await lobby.handle(second, { type: "create_room", deck });
    expect(messages).toContainEqual({ type: "error", message: "server room limit reached; retry later" });
    lobby.disconnect(first);
    await lobby.handle(second, { type: "create_room", deck });
    expect(second.room).toBeDefined();
    await second.room!.close();
    lobby.disconnect(second);
    expect(lobby.rooms.size).toBe(0);
  });

  it("validates spectator opponent decks before allocating a room", async () => {
    const lobby = new Lobby(factory);
    const messages: ServerMsg[] = [];
    const session = lobby.connect(msg => messages.push(msg));
    await lobby.handle(session, { type: "create_room", deck, spectateOnly: true, opponentDeck: { ...deck, main: [1] } });
    expect(messages.some(msg => msg.type === "error" && msg.message.startsWith("invalid opponent deck"))).toBe(true);
    expect(lobby.rooms.size).toBe(0);
  });

  it("reclaims old completed rooms when the same connection starts another duel", async () => {
    const lobby = new Lobby(factory, {}, undefined, undefined, undefined, 1);
    const session = lobby.connect(() => {});
    await lobby.handle(session, { type: "create_room", deck });
    const first = session.room!;
    await first.close();
    await lobby.handle(session, { type: "create_room", deck });
    expect(session.room).toBeDefined();
    expect(session.room).not.toBe(first);
    expect(lobby.rooms.has(first.id)).toBe(false);
    await session.room!.close();
  });

  it("serializes room mutations and prevents disconnected validation from creating rooms", async () => {
    let ready!: (value: null) => void;
    const dbReady = new Promise<null>(resolve => { ready = resolve; });
    const engine = { validateDeck: vi.fn() };
    const lobby = new Lobby(factory, {}, undefined, () => engine as never, () => dbReady);
    const messages: ServerMsg[] = [];
    const session = lobby.connect(msg => messages.push(msg));
    const pending = lobby.handle(session, { type: "create_room", deck });
    await lobby.handle(session, { type: "create_room", deck });
    expect(messages).toContainEqual({ type: "error", message: "room request already pending" });
    lobby.disconnect(session);
    ready(null);
    await pending;
    expect(lobby.rooms.size).toBe(0);
  });

  it("keeps agent reservations empty until an actual agent connects", async () => {
    const create = vi.fn(factory);
    const lobby = new Lobby(create);
    const host = lobby.connect(() => {});
    const errors: ServerMsg[] = [];
    const visitor = lobby.connect(msg => errors.push(msg));
    await lobby.handle(host, { type: "create_room", deck, opponent: { kind: "codex" } });
    const room = host.room!;
    expect(room.players).toHaveLength(1);
    expect(room.status).toBe("waiting");
    expect(create).not.toHaveBeenCalled();
    expect(lobby.list()[0].open).toBe(false);
    await lobby.handle(visitor, { type: "join_room", roomId: room.id, deck });
    expect(errors).toContainEqual({ type: "error", message: "this room is waiting for a connected agent" });
    await lobby.handle(visitor, { type: "hello", name: "Agent", kind: "agent" });
    await lobby.handle(visitor, { type: "join_room", roomId: room.id, deck });
    expect(room.seatOf(visitor)).toBe(1);
    expect(room.status).toBe("dueling");
    expect(create).toHaveBeenCalledOnce();
    await room.close();
  });

  it("waits for two real agents when an agent-only room is watched", async () => {
    const create = vi.fn(factory);
    const lobby = new Lobby(create);
    const spectator = lobby.connect(() => {});
    await lobby.handle(spectator, { type: "create_room", deck, spectateOnly: true, opponent: { kind: "claude" } });
    const room = spectator.room!;
    expect(room.players).toHaveLength(0);
    expect(room.spectators.has(spectator)).toBe(true);
    for (const name of ["Agent 0", "Agent 1"]) {
      const agent = lobby.connect(() => {});
      await lobby.handle(agent, { type: "hello", name, kind: "agent" });
      await lobby.handle(agent, { type: "join_room", roomId: room.id, deck });
    }
    expect(room.players.map(player => player.name)).toEqual(["Agent 0", "Agent 1"]);
    expect(room.status).toBe("dueling");
    expect(create).toHaveBeenCalledOnce();
    await room.close();
  });

  it("reclaims an unattended waiting bot reservation after the watcher leaves", async () => {
    const lobby = new Lobby(factory);
    const watcher = lobby.connect(() => {});
    await lobby.handle(watcher, { type: "create_room", deck, spectateOnly: true, opponent: { kind: "bot" } });
    expect(lobby.rooms.size).toBe(1);
    lobby.disconnect(watcher);
    expect(lobby.rooms.size).toBe(0);
  });

  it("denies privileged control for non-local requests even when enabled", async () => {
    vi.stubEnv("YGOSIM_ALLOW_AGENT_LAUNCH", "1");
    try {
      const app = buildApi(new Lobby(factory), () => null, () => null, async () => null);
      for (const path of ["launch", "stop"]) {
        const response = await app.request(`/api/agents/${path}`, { method: "POST", body: "{}", headers: { "content-type": "application/json", origin: "https://evil.example" } });
        expect(response.status).toBe(403);
      }
      expect((await app.request("/api/health")).status).toBe(200);
      expect((await app.request("/api/ready")).status).toBe(503);
      expect((await app.request("/api/decks/validate", { method: "POST", body: "x".repeat(65537) })).status).toBe(413);
    } finally { vi.unstubAllEnvs(); }
  });

  it("enforces WebSocket message rate and payload limits", async () => {
    const server = await startServer({ port: 0, engine: null, createDuel: factory, messagesPerSecond: 2, maxPayloadBytes: 1024 });
    try {
      for (const oversized of [false, true]) {
        const socket = new WebSocket(`ws://localhost:${server.port}/ws`);
        await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
        const closed = new Promise<number>(resolve => socket.once("close", resolve));
        if (oversized) socket.send("x".repeat(1025));
        else for (let i = 0; i < 3; i++) socket.send(JSON.stringify({ type: "hello", name: "test", kind: "human" }));
        expect(await closed).toBe(oversized ? 1009 : 1008);
      }
    } finally { await server.close(); }
  });

  it("rejects sockets beyond the connection cap", async () => {
    const server = await startServer({ port: 0, engine: null, createDuel: factory, maxConnections: 1 });
    const first = new WebSocket(`ws://localhost:${server.port}/ws`);
    try {
      await new Promise<void>((resolve, reject) => { first.once("open", resolve); first.once("error", reject); });
      const second = new WebSocket(`ws://localhost:${server.port}/ws`);
      const status = await new Promise<number>((resolve, reject) => {
        second.once("unexpected-response", (_request, response) => { response.resume(); second.terminate(); resolve(response.statusCode!); });
        second.once("error", reject);
      });
      expect(status).toBe(503);
    } finally { first.terminate(); await server.close(); }
  });

  it("rejects malformed upgrade URLs without terminating the server", async () => {
    const server = await startServer({ port: 0, engine: null, createDuel: factory });
    try {
      await new Promise<void>(resolve => {
        const socket = createConnection(server.port, "127.0.0.1", () => {
          socket.write("GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
        });
        socket.on("error", () => {});
        socket.once("close", () => resolve());
      });
      expect((await fetch(`http://127.0.0.1:${server.port}/api/health`)).status).toBe(200);
    } finally { await server.close(); }
  });

  it("rejects unregistered cards and size changes during siding without consuming the valid retry", async () => {
    const registered = { ...structuredClone(deck), side: [2000000] };
    const duel = new MockDuel([registered, registered]);
    vi.spyOn(duel, "step").mockResolvedValue({ events: [], ended: { winner: 0, reason: "test" } });
    const room = new Room(async () => duel, {}, undefined, "unlimited", "match");
    let ready!: () => void;
    const siding = new Promise<void>(resolve => { ready = resolve; });
    const messages: ServerMsg[] = [];
    const player: Participant = { id: "player", name: "player", kind: "human", send: message => {
      messages.push(message);
      if (message.type === "room" && message.status === "siding") ready();
    } };
    try {
      room.join(player, registered);
      room.join({ ...player, id: "other", send: () => {} }, registered);
      await siding;
      const newCard = structuredClone(registered);
      newCard.main[0] = 3000000;
      room.submitSideDeck(player, newCard);
      const changedSize = structuredClone(registered);
      changedSize.main.push(changedSize.side.pop()!);
      room.submitSideDeck(player, changedSize);
      expect(messages.filter(message => message.type === "error")).toHaveLength(2);
      expect(room.decks[0]).toEqual(registered);
      const valid = structuredClone(registered);
      [valid.main[0], valid.side[0]] = [valid.side[0]!, valid.main[0]!];
      room.submitSideDeck(player, valid);
      expect(room.decks[0]).toEqual(valid);
      expect(room.originalDecks[0]).toEqual(registered);
    } finally { await room.close(); }
  });
});
