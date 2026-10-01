import { describe, it, expect, beforeEach } from "vitest";
import type { Deck, ServerMsg } from "@ygosim/protocol";
import { Lobby } from "../src/lobby.js";
import { MockDuel } from "../src/mock.js";

const createValidDeck = (): Deck => {
  const main: number[] = [];
  for (let i = 0; i < 40; i++) {
    main.push(1000000 + i);
  }
  return { main, extra: [], side: [] };
};

const sampleDeck = createValidDeck();
const createMockDuel = async () => new MockDuel([sampleDeck, sampleDeck]);

describe("Enforced Deck Validation (lobby)", () => {
  let messages: ServerMsg[] = [];

  const createMockSend = () => {
    return (msg: ServerMsg) => {
      messages.push(msg);
    };
  };

  beforeEach(() => {
    messages = [];
  });

  it("should reject create_room with invalid deck BEFORE creating room", async () => {
    const lobby = new Lobby(createMockDuel, {}, undefined, undefined, undefined);
    const send = createMockSend();
    const session = lobby.connect(send);

    await lobby.handle(session, {
      type: "create_room",
      format: "tcg",
      deck: { main: [1000000], extra: [], side: [] },
    });

    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg?.type).toBe("error");
    expect(errorMsg?.message).toContain("invalid deck");
    expect(session.room).toBeUndefined();
  });

  it("should accept create_room with valid deck", async () => {
    const lobby = new Lobby(createMockDuel, {}, undefined, undefined, undefined);
    const send = createMockSend();
    const session = lobby.connect(send);

    await lobby.handle(session, {
      type: "create_room",
      format: "tcg",
      deck: sampleDeck,
    });

    const roomMsg = messages.find((m) => m.type === "room");
    expect(roomMsg?.type).toBe("room");
    expect(session.room).toBeDefined();
  });

  it("should reject join_room with invalid deck BEFORE joining", async () => {
    const lobby = new Lobby(createMockDuel, {}, undefined, undefined, undefined);
    
    const send1 = createMockSend();
    const session1 = lobby.connect(send1);
    
    await lobby.handle(session1, {
      type: "create_room",
      format: "tcg",
      deck: sampleDeck,
    });

    const roomMsg = messages.find((m) => m.type === "room");
    const roomId = (roomMsg as any)?.roomId;
    const originalRoom = session1.room;

    messages = [];
    const send2 = createMockSend();
    const session2 = lobby.connect(send2);

    await lobby.handle(session2, {
      type: "join_room",
      roomId,
      deck: { main: [1000000], extra: [], side: [] },
    });

    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg?.type).toBe("error");
    expect(errorMsg?.message).toContain("invalid deck");
    expect(session2.room).toBeUndefined();
    expect(originalRoom?.players.length).toBe(1);
  });

  it("should accept join_room with valid deck", async () => {
    const lobby = new Lobby(createMockDuel, {}, undefined, undefined, undefined);
    
    const send1 = createMockSend();
    const session1 = lobby.connect(send1);
    
    await lobby.handle(session1, {
      type: "create_room",
      format: "tcg",
      deck: sampleDeck,
    });

    const roomMsg = messages.find((m) => m.type === "room");
    const roomId = (roomMsg as any)?.roomId;

    messages = [];
    const send2 = createMockSend();
    const session2 = lobby.connect(send2);

    await lobby.handle(session2, {
      type: "join_room",
      roomId,
      deck: sampleDeck,
    });

    const joinRoomMsg = messages.find((m) => m.type === "room");
    expect(joinRoomMsg?.type).toBe("room");
    expect(session2.room).toBeDefined();
  });

  it("should reject join_room when room is full", async () => {
    const lobby = new Lobby(createMockDuel, {}, undefined, undefined, undefined);
    
    const send1 = createMockSend();
    const session1 = lobby.connect(send1);
    await lobby.handle(session1, {
      type: "create_room",
      format: "tcg",
      deck: sampleDeck,
    });

    const roomMsg = messages.find((m) => m.type === "room");
    const roomId = (roomMsg as any)?.roomId;

    messages = [];
    const send2 = createMockSend();
    const session2 = lobby.connect(send2);
    await lobby.handle(session2, {
      type: "join_room",
      roomId,
      deck: sampleDeck,
    });

    messages = [];
    const send3 = createMockSend();
    const session3 = lobby.connect(send3);
    await lobby.handle(session3, {
      type: "join_room",
      roomId,
      deck: sampleDeck,
    });

    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg?.type).toBe("error");
    expect(errorMsg?.message).toContain("room is full");
  });

  it("should reject side_deck with invalid deck BEFORE accepting", async () => {
    const lobby = new Lobby(createMockDuel, {}, undefined, undefined, undefined);
    const send = createMockSend();
    const session = lobby.connect(send);

    await lobby.handle(session, {
      type: "create_room",
      format: "tcg",
      match: "match",
      deck: sampleDeck,
    });

    const room = session.room;
    expect(room).toBeDefined();

    (room as any).status = "siding";

    messages = [];
    await lobby.handle(session, {
      type: "side_deck",
      deck: { main: [1000000], extra: [], side: [] },
    });

    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg?.type).toBe("error");
    expect(errorMsg?.message).toContain("invalid");
    expect(room?.decks[0]).toEqual(sampleDeck);
  });
});

describe("Real-engine TCG validation", { skip: !process.env.YGOSIM_TEST_ENGINE }, () => {
  it("rejects Pot of Greed before creating a room and leaves /api/rooms empty", async () => {
    const { loadEngine } = await import("../src/engine.js");
    const { buildApi } = await import("../src/server.js");
    const engine = await loadEngine();
    if (!engine) throw new Error("YGOSIM_TEST_ENGINE requires the real engine");
    const db = await engine.loadCardDb();
    const lobby = new Lobby(opts => engine.createDuel(opts), {}, undefined, () => engine, async () => db);
    const app = buildApi(lobby, () => db, () => engine, async () => db, engine.parseYdk);
    const decks = await (await app.request("/api/decks")).json() as { id: string; deck: Deck }[];
    const sample = decks.find(deck => deck.id === "junk-synchro" || deck.id === "utopia-xyz");
    expect(sample).toBeDefined();
    const deck = structuredClone(sample!.deck);
    deck.main[0] = 55144522;
    const messages: ServerMsg[] = [];
    const session = lobby.connect(msg => messages.push(msg));
    try {
      await lobby.handle(session, { type: "create_room", format: "tcg", deck });
      expect(messages).toContainEqual({ type: "error", message: expect.stringMatching(/invalid deck:.*Pot of Greed.*Forbidden/i) });
      expect(session.room).toBeUndefined();
      expect(await (await app.request("/api/rooms")).json()).toEqual([]);
    } finally {
      lobby.disconnect(session);
    }
  }, 20_000);
});
