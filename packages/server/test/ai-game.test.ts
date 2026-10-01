import { describe, it, expect } from "vitest";
import type { Deck, ServerMsg } from "@ygosim/protocol";
import { Room } from "../src/room.js";
import { createBot } from "../src/ai/index.js";
import { MockDuel } from "../src/mock.js";

const sampleDeck: Deck = { main: Array(40).fill(123), extra: [], side: [] };

describe("AI vs AI Game", () => {
  const createMockDuel = async () => new MockDuel([sampleDeck, sampleDeck]);

  it("should play a full game: easy vs normal bots", async () => {
    const messages: ServerMsg[] = [];

    const createParticipant = (id: string, name: string, level?: string) => {
      const bot = level ? createBot(level as any) : undefined;
      return {
        id,
        name,
        kind: "bot" as const,
        bot,
        send: (msg: ServerMsg) => {
          messages.push(msg);
        },
      };
    };

    const room = new Room(createMockDuel);
    const easyBot = createParticipant("bot-easy", "Easy Bot", "easy");
    const normalBot = createParticipant("bot-normal", "Normal Bot", "normal");

    const idx1 = room.join(easyBot, sampleDeck);
    const idx2 = room.join(normalBot, sampleDeck);

    expect(idx1).toBe(0);
    expect(idx2).toBe(1);
    expect(room.status).toBe("dueling");

    // Wait for game to finish (MockDuel has a turn limit)
    await room.finished;

    expect(room.status).toBe("done");
    const roomMsgs = messages.filter((m) => m.type === "room");
    expect(roomMsgs[roomMsgs.length - 1].status).toBe("done");
  });

  it("should play a full game: normal vs hard bots", async () => {
    const messages: ServerMsg[] = [];

    const createParticipant = (id: string, name: string, level?: string) => {
      const bot = level ? createBot(level as any) : undefined;
      return {
        id,
        name,
        kind: "bot" as const,
        bot,
        send: (msg: ServerMsg) => {
          messages.push(msg);
        },
      };
    };

    const room = new Room(createMockDuel);
    const normalBot = createParticipant("bot-normal", "Normal Bot", "normal");
    const hardBot = createParticipant("bot-hard", "Hard Bot", "hard");

    room.join(normalBot, sampleDeck);
    room.join(hardBot, sampleDeck);

    expect(room.status).toBe("dueling");

    await room.finished;

    expect(room.status).toBe("done");
  });

  it("should handle all AI levels: easy, normal, hard", async () => {
    const levels: Array<"easy" | "normal" | "hard"> = ["easy", "normal", "hard"];

    for (const level of levels) {
      const messages: ServerMsg[] = [];
      const bot = createBot(level);
      expect(bot.name).toBeDefined();
      expect(bot.choose).toBeDefined();
    }
  });
});
