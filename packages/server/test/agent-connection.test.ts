import { expect, it } from "vitest";
import { GameClient } from "../../mcp/src/client.js";
import { createBot } from "../src/ai/index.js";
import { sampleDecks } from "../src/decks.js";
import { startServer } from "../src/server.js";

it("connected MCP agents fill a reserved seat and finish a real duel", { skip: !process.env.YGOSIM_TEST_ENGINE, timeout: 60_000 }, async () => {
  const server = await startServer({ port: 0, botDelayMs: 0, seed: 42 });
  const deck = sampleDecks().find(value => value.id === "blue-eyes-fusion")!.deck;
  const host = new GameClient(`ws://127.0.0.1:${server.port}/ws`, "Host");
  const opponent = new GameClient(`ws://127.0.0.1:${server.port}/ws`, "Connected agent");
  try {
    await host.connect();
    const created = host.next(message => message.type === "room", 10_000);
    host.send({ type: "create_room", deck, opponent: { kind: "codex" }, format: "unlimited" });
    await created;
    const room = server.lobby.rooms.get(host.room!.roomId)!;
    expect(room.status).toBe("waiting");
    expect(room.isFull).toBe(false);
    await opponent.joinRoom(room.id, deck);
    expect(room.status).toBe("dueling");
    const play = async (client: GameClient) => {
      const bot = createBot("normal");
      let decisions = 0;
      while (decisions < 2000) {
        const result = await client.waitForTurn(10_000);
        if (result.kind === "ended") return { ...result, decisions };
        expect(result.kind).toBe("prompt");
        if (result.kind !== "prompt") throw new Error(`Agent failed: ${JSON.stringify(result)}`);
        expect(client.state).toBeDefined();
        const action = await bot.choose(client.state!, result.prompt);
        client.act(action.choose, action.promptId);
        client.drainEvents();
        decisions++;
      }
      throw new Error("Agent duel exceeded its decision budget");
    };
    const outcomes = await Promise.all([play(host), play(opponent)]);
    await room.finished;
    expect(room.status).toBe("done");
    expect(room.winner).not.toBeUndefined();
    expect(room.diagnostics.rejectedActions).toBe(0);
    for (const outcome of outcomes) {
      expect(outcome.decisions).toBeGreaterThan(0);
      expect(outcome.reason).not.toMatch(/abort|timeout|surrender|closed/);
      expect(outcome.winner).toBe(room.winner);
    }
  } finally {
    host.close();
    opponent.close();
    await server.close();
  }
});
