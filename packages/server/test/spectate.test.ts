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

describe("Spectator Mode", () => {
  let messages: ServerMsg[] = [];

  const createMockSend = () => {
    return (msg: ServerMsg) => {
      messages.push(msg);
    };
  };

  beforeEach(() => {
    messages = [];
  });

  it("should allow spectating an existing room", async () => {
    const lobby = new Lobby(createMockDuel, {}, undefined, undefined, undefined);

    // Player 1 creates room
    const send1 = createMockSend();
    const session1 = lobby.connect(send1);
    await lobby.handle(session1, {
      type: "create_room",
      format: "tcg",
      deck: sampleDeck,
    });

    const roomMsg = messages.find((m) => m.type === "room") as any;
    const roomId = roomMsg?.roomId;

    messages = [];

    // Spectator joins room
    const sendSpectator = createMockSend();
    const spectator = lobby.connect(sendSpectator);
    await lobby.handle(spectator, {
      type: "spectate",
      roomId,
    });

    const spectatorRoomMsg = messages.find((m) => m.type === "room") as any;
    expect(spectatorRoomMsg).toBeDefined();
    expect(spectatorRoomMsg.roomId).toBe(roomId);
    expect(spectatorRoomMsg.status).toBe("waiting");
  });

  it("should reject spectating non-existent room", async () => {
    const lobby = new Lobby(createMockDuel, {}, undefined, undefined, undefined);

    const send = createMockSend();
    const session = lobby.connect(send);
    await lobby.handle(session, {
      type: "spectate",
      roomId: "nonexistent",
    });

    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg?.type).toBe("error");
  });

  it("should support spectateOnly mode", async () => {
    const lobby = new Lobby(createMockDuel, {}, undefined, undefined, undefined);

    const send = createMockSend();
    const session = lobby.connect(send);

    await lobby.handle(session, {
      type: "create_room",
      format: "tcg",
      deck: sampleDeck,
      spectateOnly: true,
      opponent: { kind: "bot", level: "normal" },
    });

    const roomMsg = messages.find((m) => m.type === "room") as any;
    expect(roomMsg).toBeDefined();
    expect(roomMsg.status).toBe("waiting");
  });
});
