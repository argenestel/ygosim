import { describe, it, expect } from "vitest";
import type { Deck, ServerMsg } from "@ygosim/protocol";
import { Lobby } from "../src/lobby.js";
import { MockDuel } from "../src/mock.js";

// Create a valid deck: 40 cards with different codes
const createValidDeck = (): Deck => {
  const main: number[] = [];
  for (let i = 0; i < 40; i++) {
    main.push(1000000 + i);
  }
  return { main, extra: [], side: [] };
};

const sampleDeck = createValidDeck();

describe("Lobby", () => {
  const createMockDuel = async () => new MockDuel([sampleDeck, sampleDeck]);

  it("should welcome clients on connect", () => {
    const messages: ServerMsg[] = [];
    const lobby = new Lobby(createMockDuel);
    const send = (msg: ServerMsg) => messages.push(msg);

    const session = lobby.connect(send);
    expect(session.hello).toBe(false);
    expect(session.kind).toBe("human");
    expect(messages[0].type).toBe("welcome");
  });

  it("should update player name and kind on hello", async () => {
    const messages: ServerMsg[] = [];
    const lobby = new Lobby(createMockDuel);
    const send = (msg: ServerMsg) => messages.push(msg);

    const session = lobby.connect(send);
    await lobby.handle(session, { type: "hello", name: "Alice", kind: "agent" });
    expect(session.hello).toBe(true);
    expect(session.name).toBe("Alice");
    expect(session.kind).toBe("agent");
  });

  it("should create a room", async () => {
    const messages: ServerMsg[] = [];
    const lobby = new Lobby(createMockDuel);
    const send = (msg: ServerMsg) => messages.push(msg);

    const session = lobby.connect(send);
    messages.length = 0; // Clear welcome

    await lobby.handle(session, { type: "hello", name: "Player1", kind: "human" });
    await lobby.handle(session, { type: "create_room", deck: sampleDeck });

    expect(session.room).toBeDefined();
    expect(session.room?.status).toBe("waiting");
  });

  it("should list active rooms with player names as strings", async () => {
    const messages: ServerMsg[] = [];
    const lobby = new Lobby(createMockDuel);
    const send = (msg: ServerMsg) => messages.push(msg);

    const session = lobby.connect(send);
    await lobby.handle(session, { type: "hello", name: "Player1", kind: "human" });
    await lobby.handle(session, { type: "create_room", deck: sampleDeck });

    const rooms = lobby.list();
    expect(rooms.length).toBeGreaterThan(0);
    expect(rooms[0].players).toContain("Player1");
    expect(Array.isArray(rooms[0].players)).toBe(true);
    expect(typeof rooms[0].players[0]).toBe("string");
    expect(rooms[0].status).toBe("waiting");
  });

  it("should create room with AI opponent", async () => {
    const messages: ServerMsg[] = [];
    const lobby = new Lobby(createMockDuel);
    const send = (msg: ServerMsg) => messages.push(msg);

    const session = lobby.connect(send);
    await lobby.handle(session, { type: "hello", name: "Player1", kind: "human" });
    await lobby.handle(session, { type: "create_room", vsAI: true, aiLevel: "normal", deck: sampleDeck });

    const rooms = lobby.list();
    expect(rooms.length).toBeGreaterThan(0);
    expect(rooms[0].players).toContain("Player1");
    expect(rooms[0].players.some((p: string) => p.includes("AI"))).toBe(true);
  });

  it("should reject invalid deck in create_room", async () => {
    const messages: ServerMsg[] = [];
    const lobby = new Lobby(createMockDuel);
    const send = (msg: ServerMsg) => messages.push(msg);

    const session = lobby.connect(send);
    messages.length = 0;

    await lobby.handle(session, { type: "hello", name: "Player1", kind: "human" });
    await lobby.handle(session, { type: "create_room", deck: { main: [123], extra: [], side: [] } }); // Too small

    const errors = messages.filter((m) => m.type === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("invalid deck");
  });

  it("should reject malformed messages", async () => {
    const messages: ServerMsg[] = [];
    const lobby = new Lobby(createMockDuel);
    const send = (msg: ServerMsg) => messages.push(msg);

    const session = lobby.connect(send);
    messages.length = 0;

    await lobby.handle(session, "not an object" as any);
    const errors = messages.filter((m) => m.type === "error");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("should handle unknown message types", async () => {
    const messages: ServerMsg[] = [];
    const lobby = new Lobby(createMockDuel);
    const send = (msg: ServerMsg) => messages.push(msg);

    const session = lobby.connect(send);
    messages.length = 0;

    await lobby.handle(session, { type: "unknown_type" } as any);
    const errors = messages.filter((m) => m.type === "error");
    expect(errors.length).toBeGreaterThan(0);
  });
});
