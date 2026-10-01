import { describe, it, expect } from "vitest";
import { WebSocket } from "ws";
import type { ClientMsg, Deck, ServerMsg } from "@ygosim/protocol";
import { startServer } from "../src/server.js";
import { sampleDecks } from "../src/decks.js";
import { defaultAction } from "../src/ai/index.js";
import { Lobby } from "../src/lobby.js";
import { loadEngine } from "../src/engine.js";

function matchDecks() {
  const original = sampleDecks().find(d => d.id === "vanilla-dragons")?.deck;
  if (!original) throw new Error("vanilla-dragons sample deck is required");
  const deck: Deck = { ...structuredClone(original), side: [4148264] };
  const sided = structuredClone(deck);
  [sided.main[0], sided.side[0]] = [sided.side[0], sided.main[0]];
  return { deck, sided };
}

// Real engine and local card data are required; opt in explicitly.
describe("Live Integration Test (WebSocket)", { skip: !process.env.YGOSIM_TEST_ENGINE }, () => {
  async function play(match: "single" | "match") {
    const { deck, sided } = matchDecks();
    const server = await startServer({ port: 0, botDelayMs: 0, turnTimeoutMs: 5000 });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const messages: ServerMsg[] = [];
    const sidedGames = new Set<number>();
    const promptsPerGame = new Map<number, number>();
    let game = 1;
    let promptCount = 0;
    const send = (msg: ClientMsg) => ws.send(JSON.stringify(msg));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: unknown) => { reject(error); ws.terminate(); };
        timer = setTimeout(() => fail(new Error(`WebSocket ${match} test timed out at game ${game}`)), 50_000);
        ws.on("error", fail);
        ws.on("close", () => reject(new Error("WebSocket closed before match completion")));
        ws.on("message", data => {
          try {
            const msg = JSON.parse(String(data)) as ServerMsg;
            messages.push(msg);
            switch (msg.type) {
              case "welcome":
                send({ type: "hello", name: "TestPlayer", kind: "human" });
                send({ type: "create_room", vsAI: true, aiLevel: "normal", deck, format: "unlimited", match });
                break;
              case "room":
                game = msg.game ?? 1;
                if (msg.status === "siding" && !sidedGames.has(game)) {
                  sidedGames.add(game);
                  send({ type: "side_deck", deck: sided });
                }
                if (msg.status === "dueling" && game > 1) expect(server.lobby.rooms.get(msg.roomId)?.decks[0]).toEqual(sided);
                if (msg.status === "done") resolve();
                break;
              case "prompt":
                if (++promptCount > 3000) throw new Error("Exceeded 3000 prompts without completion");
                promptsPerGame.set(game, (promptsPerGame.get(game) ?? 0) + 1);
                send({ type: "action", action: defaultAction(msg.prompt) });
                break;
              case "error":
                throw new Error(`Server error: ${msg.message}`);
            }
          } catch (error) { fail(error); }
        });
      });
      const rooms = messages.filter((msg): msg is Extract<ServerMsg, { type: "room" }> => msg.type === "room");
      const wins = messages.flatMap(msg => msg.type === "events" ? msg.events.filter(event => event.t === "win") : []);
      expect(messages.some(msg => msg.type === "welcome")).toBe(true);
      expect(promptCount).toBeGreaterThan(0);
      expect(rooms.at(-1)?.status).toBe("done");
      expect(wins.length).toBeGreaterThan(0);
      return { rooms, wins, sidedGames, promptsPerGame };
    } finally {
      clearTimeout(timer);
      ws.terminate();
      await server.close();
    }
  }

  it("plays a complete AI game via WebSocket", async () => {
    const { wins, sidedGames } = await play("single");
    expect(wins).toHaveLength(1);
    expect(sidedGames.size).toBe(0);
  }, 60_000);

  it("plays a Bo3 vs AI with submitted side decks and completes at two wins", async () => {
    const { rooms, wins, sidedGames, promptsPerGame } = await play("match");
    const final = rooms.at(-1)!;
    expect(final.match).toBe("match");
    expect(final.format).toBe("unlimited");
    expect(final.game).toBeGreaterThanOrEqual(2);
    expect(final.game).toBeLessThanOrEqual(3);
    expect(wins).toHaveLength(final.game!);
    const expectedScore: [number, number] = [0, 0];
    for (const [index, win] of wins.entries()) {
      expect(win.winner).not.toBeNull();
      expectedScore[win.winner!]++;
      const boundary = rooms.find(msg => msg.game === index + 1 && (msg.status === "siding" || msg.status === "done"));
      expect(boundary?.score).toEqual(expectedScore);
    }
    expect(final.score).toEqual(expectedScore);
    expect(Math.max(...final.score!)).toBe(2);
    expect(sidedGames.size).toBe(final.game! - 1);
    for (let game = 1; game <= final.game!; game++) expect(promptsPerGame.get(game)).toBeGreaterThan(0);
    expect(rooms.filter(msg => msg.status === "done")).toHaveLength(1);
  }, 60_000);

  it("plays a real-engine Bo3 through the lobby with side-deck submissions", async () => {
    const engine = await loadEngine();
    if (!engine) throw new Error("YGOSIM_TEST_ENGINE requires the real engine");
    const { deck, sided } = matchDecks();
    const createdDecks: [Deck, Deck][] = [];
    const lobby = new Lobby(async opts => {
      createdDecks.push(structuredClone(opts.decks));
      return engine.createDuel(opts);
    }, { botDelayMs: 0, seed: 1 });
    const messages: ServerMsg[] = [];
    const session = lobby.connect(msg => {
      messages.push(structuredClone(msg));
      // Use the same wire messages routed by the WebSocket handler.
      if (msg.type === "prompt") queueMicrotask(() => lobby.handle(session, { type: "action", action: defaultAction(msg.prompt) }));
      if (msg.type === "room" && msg.status === "siding") queueMicrotask(() => lobby.handle(session, { type: "side_deck", deck: sided }));
    });
    lobby.handle(session, { type: "hello", name: "Integration Player", kind: "human" });
    lobby.handle(session, { type: "create_room", vsAI: true, aiLevel: "normal", format: "unlimited", match: "match", deck });
    const room = session.room!;
    await room.finished;
    expect(messages.filter(msg => msg.type === "error")).toEqual([]);
    expect(room.status).toBe("done");
    expect(room.score).toEqual([0, 2]);
    expect(room.game).toBe(2);
    expect(createdDecks).toEqual([[deck, deck], [sided, deck]]);
    const boundaries = messages.flatMap(msg => msg.type === "room" && (msg.status === "siding" || msg.status === "done") ? [msg] : []);
    expect(boundaries.map(msg => [msg.status, msg.game, msg.score])).toEqual([["siding", 1, [0, 1]], ["done", 2, [0, 2]]]);
    expect(messages.flatMap(msg => msg.type === "events" ? msg.events.filter(event => event.t === "win") : [])).toHaveLength(2);
    expect(new Set(messages.flatMap(msg => msg.type === "events" ? [msg.state.duelId] : [])).size).toBe(2);
  }, 60_000);
});
