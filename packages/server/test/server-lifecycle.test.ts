import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createBot } from "../src/ai/index.js";
import { MockDuel } from "../src/mock.js";
import { Room, type Participant } from "../src/room.js";
import type { Deck, ServerMsg } from "@ygosim/protocol";

const { serve } = vi.hoisted(() => ({ serve: vi.fn() }));
vi.mock("@hono/node-server", () => ({ serve }));

const deck: Deck = { main: Array.from({ length: 40 }, (_, i) => 1000000 + i), extra: [], side: [] };
const player = (id: string, send: (msg: ServerMsg) => void = () => {}): Participant => ({ id, name: id, kind: "human", send });

describe("Server lifecycle", () => {
  it("rejects startup when listening fails instead of hanging", async () => {
    const http = new EventEmitter();
    const error = new Error("listen failed");
    serve.mockImplementationOnce(() => {
      queueMicrotask(() => http.emit("error", error));
      return http;
    });
    const { startServer } = await import("../src/server.js");
    await expect(startServer({ port: 0, engine: null })).rejects.toBe(error);
    expect(http.listenerCount("listening")).toBe(0);
  });

  it("uses the assigned ephemeral port in agent connection commands", async () => {
    const http = Object.assign(new EventEmitter(), {
      listening: true,
      address: () => ({ port: 54321 }),
      close: (callback: () => void) => callback(),
      closeAllConnections: vi.fn(),
    });
    serve.mockReturnValueOnce(http);
    const { startServer } = await import("../src/server.js");
    const server = await startServer({ port: 0, engine: null });
    try {
      expect(server.port).toBe(54321);
      const agents = await (await server.app.request("/api/agents")).json();
      expect(agents).toHaveLength(2);
      for (const agent of agents) expect(agent.connectCommand).toContain("YGOSIM_URL=ws://localhost:54321");
    } finally {
      await server.close();
    }
  });

  it("lets deadlines interrupt a synchronous engine and bot loop", async () => {
    const duel = new MockDuel([deck, deck]);
    vi.spyOn(duel, "step").mockResolvedValue({
      events: [], pending: { player: 0, prompt: {
        promptId: "repeat", kind: "idle", text: "Repeated prompt", min: 1, max: 1,
        options: [{ id: "end", label: "End turn" }],
      } },
    });
    vi.spyOn(duel, "respond").mockImplementation(() => {});
    const room = new Room(async () => duel);
    const bot = createBot("easy");
    room.join({ ...player("p0"), kind: "bot", bot }, deck);
    room.join({ ...player("p1"), kind: "bot", bot }, deck);
    const timer = setTimeout(() => { void room.close(); }, 0);
    try {
      await room.finished;
      expect(room.status).toBe("done");
    } finally {
      clearTimeout(timer);
      await room.close();
    }
  });

  it("cancels a pending decision and destroys the duel on close", async () => {
    vi.useFakeTimers();
    const duel = new MockDuel([deck, deck]);
    const destroy = vi.spyOn(duel, "destroy");
    let prompted!: () => void;
    const prompt = new Promise<void>(resolve => { prompted = resolve; });
    const room = new Room(async () => duel);
    room.join(player("p0", msg => { if (msg.type === "prompt") prompted(); }), deck);
    room.join(player("p1", msg => { if (msg.type === "prompt") prompted(); }), deck);
    try {
      await prompt;
      expect(vi.getTimerCount()).toBe(1);
      await room.close();
      expect(room.status).toBe("done");
      expect(destroy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await room.close();
      vi.useRealTimers();
    }
  });

  it("cancels siding timers without starting another game", async () => {
    vi.useFakeTimers();
    const duel = new MockDuel([deck, deck]);
    vi.spyOn(duel, "step").mockResolvedValue({ events: [], ended: { winner: 0, reason: "test" } });
    const createDuel = vi.fn(async () => duel);
    let sided!: () => void;
    const siding = new Promise<void>(resolve => { sided = resolve; });
    const room = new Room(createDuel, {}, undefined, "unlimited", "match");
    room.join(player("p0", msg => { if (msg.type === "room" && msg.status === "siding") sided(); }), deck);
    room.join(player("p1"), deck);
    try {
      await siding;
      expect(vi.getTimerCount()).toBe(2);
      await room.close();
      expect(room.status).toBe("done");
      expect(createDuel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await room.close();
      vi.useRealTimers();
    }
  });
});
