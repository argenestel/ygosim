import { afterEach, describe, expect, it, vi } from "vitest";
import type { Deck, PlayerIdx, ServerMsg, StepResult } from "@ygosim/protocol";
import { MockDuel } from "../src/mock.js";
import { Room, type Participant } from "../src/room.js";
import { createBot } from "../src/ai/index.js";

const deck = (): Deck => ({ main: Array.from({ length: 40 }, (_, i) => 1000000 + i), extra: [], side: [2000000] });
const sidedDeck = (): Deck => {
  const next = deck();
  [next.main[0], next.side[0]] = [next.side[0], next.main[0]];
  return next;
};

// Exercise MockDuel's normal prompts and 20-turn loop with decisive results.
class WinningMockDuel extends MockDuel {
  constructor(decks: [Deck, Deck], private winner: PlayerIdx | null) { super(decks); }
  override async step(): Promise<StepResult> {
    const result = await super.step();
    return result.ended ? {
      events: [{ t: "win", winner: this.winner, reason: "test game ended" }],
      ended: { winner: this.winner, reason: "test game ended" },
    } : result;
  }
}

function setup(winners: (PlayerIdx | null)[], format = "tcg", match: "single" | "match" = "match", bots: PlayerIdx[] = []) {
  const messages: ServerMsg[][] = [[], []];
  const choices: PlayerIdx[] = [];
  const duels: WinningMockDuel[] = [];
  const createDuel = vi.fn(async (opts: Parameters<import("../src/room.js").CreateDuel>[0]) => {
    const duel = new WinningMockDuel(opts.decks, winners[duels.length]);
    vi.spyOn(duel, "destroy");
    duels.push(duel);
    return duel;
  });
  const room = new Room(createDuel, {}, undefined, format, match);
  const players = ([0, 1] as const).map((seat): Participant => ({
    id: `p${seat}`, name: `Player ${seat}`, kind: bots.includes(seat) ? "bot" : "human",
    bot: bots.includes(seat) ? createBot("easy") : undefined,
    send(msg) {
      messages[seat].push(structuredClone(msg));
      if (msg.type === "prompt") queueMicrotask(() => {
        if (msg.prompt.kind === "first_turn") choices.push(seat);
        room.submit(players[seat], { promptId: msg.prompt.promptId, choose: [msg.prompt.kind === "first_turn" ? "1" : "end"] });
      });
    },
  }));
  const start = () => { room.join(players[0], deck()); room.join(players[1], deck()); };
  const side = () => { room.submitSideDeck(players[0], sidedDeck()); room.submitSideDeck(players[1], deck()); };
  return { room, players, messages, choices, createDuel, duels, start, side };
}

const flush = async () => { for (let i = 0; i < 500; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("Formats and best-of-three matches (MockDuel)", () => {
  it.each(["tcg", "ocg", "traditional", "unlimited", "goat", "edison", "speed"])("preserves and forwards the %s format", async (format) => {
    const test = setup([0], format, "single");
    test.start();
    await test.room.finished;
    expect(test.room.format).toBe(format);
    expect(test.createDuel).toHaveBeenCalledWith(expect.objectContaining({ format }));
    expect(test.messages[0].filter(m => m.type === "room").every(m => m.format === format && m.match === "single")).toBe(true);
    expect(test.duels).toHaveLength(1);
    expect(test.room.status).toBe("done");
  });

  it("plays three games with siding, score tracking, and the previous loser's first-turn choice", async () => {
    const test = setup([0, 1, 0]);
    test.start();
    await flush();
    expect(test.room.status).toBe("siding");
    expect(test.room.score).toEqual([1, 0]);
    test.room.submitSideDeck(test.players[0], sidedDeck());
    await flush();
    expect(test.room.status).toBe("siding");
    expect(test.duels).toHaveLength(1);
    test.room.submitSideDeck(test.players[1], deck());
    await flush();
    expect(test.room.status).toBe("siding");
    expect(test.room.score).toEqual([1, 1]);
    expect(test.room.game).toBe(2);
    expect(test.createDuel.mock.calls[1][0].decks[0]).toEqual(sidedDeck());
    expect(test.createDuel.mock.calls[1][0]).toMatchObject({ firstPlayer: 1 });
    test.side();
    await test.room.finished;
    expect(test.choices).toEqual([1, 0]);
    expect(test.room.score).toEqual([2, 1]);
    expect(test.room.game).toBe(3);
    expect(test.room.winner).toBe(0);
    expect(test.room.status).toBe("done");
    expect(test.duels).toHaveLength(3);
    for (const duel of test.duels) expect(duel.destroy).toHaveBeenCalledTimes(1);
    expect(test.messages[0].flatMap(m => m.type === "room" && m.status === "siding" ? [m.score] : [])).toEqual([[1, 0], [1, 1]]);
    expect(test.messages.flat().filter(m => m.type === "error")).toEqual([]);
  });

  it("ends at two wins and resets surrender between games", async () => {
    const test = setup([0, 0], "tcg", "match", [1]);
    test.players[0].send = msg => {
      test.messages[0].push(structuredClone(msg));
      if (msg.type === "prompt") queueMicrotask(() => {
        if (msg.prompt.kind === "first_turn") test.room.submit(test.players[0], { promptId: msg.prompt.promptId, choose: ["0"] });
        else test.room.surrender(test.players[0]);
      });
    };
    test.start();
    await flush();
    expect(test.room.score).toEqual([0, 1]);
    expect(test.room.status).toBe("siding");
    test.room.submitSideDeck(test.players[0], sidedDeck());
    await test.room.finished;
    expect(test.room.score).toEqual([0, 2]);
    expect(test.room.game).toBe(2);
    expect(test.room.winner).toBe(1);
    expect(test.room.status).toBe("done");
    expect(test.duels).toHaveLength(2);
  });

  it("allows each human 60 seconds to side and keeps an unsubmitted deck", async () => {
    vi.useFakeTimers();
    const test = setup([0, 0]);
    test.start();
    await flush();
    expect(test.room.status).toBe("siding");
    test.room.submitSideDeck(test.players[0], sidedDeck());
    await vi.advanceTimersByTimeAsync(59_999);
    expect(test.room.status).toBe("siding");
    expect(test.duels).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await test.room.finished;
    expect(test.createDuel.mock.calls[1][0].decks).toEqual([sidedDeck(), deck()]);
    expect(test.room.score).toEqual([2, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("AI confirms its original deck without waiting 60 seconds", async () => {
    vi.useFakeTimers();
    const test = setup([0, 0], "ocg", "match", [1]);
    // Simulate a previously changed AI deck before the first siding phase.
    test.room.join(test.players[0], deck());
    test.room.join(test.players[1], deck());
    test.room.decks[1] = sidedDeck();
    await flush();
    expect(test.room.status).toBe("siding");
    test.room.submitSideDeck(test.players[0], sidedDeck());
    await flush();
    await test.room.finished;
    expect(test.createDuel.mock.calls[1][0].decks[1]).toEqual(deck());
    expect(test.room.score).toEqual([2, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
