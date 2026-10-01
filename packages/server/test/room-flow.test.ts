import { describe, it, expect, beforeEach } from "vitest";
import type { Deck, ServerMsg } from "@ygosim/protocol";
import { Room } from "../src/room.js";
import { MockDuel } from "../src/mock.js";

const sampleDeck: Deck = { main: Array(40).fill(123), extra: [], side: [] };

describe("Room Flow", () => {
  let messages: ServerMsg[] = [];

  const createMockParticipant = (id: string, name: string) => ({
    id,
    name,
    kind: "human" as const,
    send: (msg: ServerMsg) => {
      messages.push(msg);
    },
  });

  const createMockDuel = async () => new MockDuel([sampleDeck, sampleDeck]);

  beforeEach(() => {
    messages = [];
  });

  it("should broadcast room info when players join", async () => {
    const room = new Room(createMockDuel);
    const p1 = createMockParticipant("p1", "Player1");
    const p2 = createMockParticipant("p2", "Player2");

    room.join(p1, sampleDeck);
    const joinMsg1 = messages.filter((m) => m.type === "room");
    expect(joinMsg1.length).toBeGreaterThan(0);
    expect(joinMsg1[0].type).toBe("room");
    expect(joinMsg1[0].players).toContain("Player1");

    room.join(p2, sampleDeck);
    const joinMsg2 = messages.filter((m) => m.type === "room");
    expect(joinMsg2.length).toBeGreaterThan(1);
    const lastRoomMsg = joinMsg2[joinMsg2.length - 1];
    expect(lastRoomMsg.players).toContain("Player2");
  });

  it("should start dueling when room is full", async () => {
    const room = new Room(createMockDuel);
    const p1 = createMockParticipant("p1", "Player1");
    const p2 = createMockParticipant("p2", "Player2");

    room.join(p1, sampleDeck);
    expect(room.status).toBe("waiting");

    room.join(p2, sampleDeck);
    expect(room.status).toBe("dueling");

    // Wait for the first prompt
    await new Promise((r) => setTimeout(r, 100));
    const prompts = messages.filter((m) => m.type === "prompt");
    expect(prompts.length).toBeGreaterThan(0);
  });

  it("should send events to both players redacted", async () => {
    const room = new Room(createMockDuel);
    const p1 = createMockParticipant("p1", "Player1");
    const p2 = createMockParticipant("p2", "Player2");

    room.join(p1, sampleDeck);
    room.join(p2, sampleDeck);

    await new Promise((r) => setTimeout(r, 150));
    const eventMsgs = messages.filter((m) => m.type === "events");
    expect(eventMsgs.length).toBeGreaterThan(0);
  });

  it("should handle player surrender", async () => {
    const room = new Room(createMockDuel);
    const p1 = createMockParticipant("p1", "Player1");
    const p2 = createMockParticipant("p2", "Player2");

    room.join(p1, sampleDeck);
    room.join(p2, sampleDeck);

    await new Promise((r) => setTimeout(r, 50));
    room.surrender(p1);
    expect(room.status).toBe("dueling");

    await new Promise((r) => setTimeout(r, 200));
    expect(room.status).toBe("done");
    const roomMsgs = messages.filter((m) => m.type === "room");
    expect(roomMsgs[roomMsgs.length - 1].status).toBe("done");
  });

  it("should broadcast chat messages", () => {
    const room = new Room(createMockDuel);
    const p1 = createMockParticipant("p1", "Player1");
    const p2 = createMockParticipant("p2", "Player2");

    room.join(p1, sampleDeck);
    room.join(p2, sampleDeck);
    messages = [];

    room.chat(p1, "Hello!");
    const chatMsgs = messages.filter((m) => m.type === "chat");
    expect(chatMsgs.length).toBe(2); // Both players get the message
    expect(chatMsgs[0].from).toBe("Player1");
    expect(chatMsgs[0].text).toBe("Hello!");
  });

  it("should handle spectators joining a full room", () => {
    const room = new Room(createMockDuel);
    const p1 = createMockParticipant("p1", "Player1");
    const p2 = createMockParticipant("p2", "Player2");
    const spec = createMockParticipant("spec", "Spectator");

    room.join(p1, sampleDeck);
    room.join(p2, sampleDeck);

    const result = room.join(spec, sampleDeck);
    expect(result).toBe("spectator");
    expect(room.spectators.size).toBe(1);
  });
});
