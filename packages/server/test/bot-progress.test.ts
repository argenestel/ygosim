import { describe, expect, it, vi } from "vitest";
import type { Deck, Duel, DuelState, Prompt, ServerMsg } from "@ygosim/protocol";
import { BotProgress, actionDiagnostic, fingerprint } from "../src/ai/progress.js";
import { Room, type Participant } from "../src/room.js";

const state: DuelState = { duelId: "test", turn: 2, turnPlayer: 0, phase: "main1", lp: [8000, 8000], cards: [], chain: [], you: 0 };
const prompt: Prompt = { promptId: "0", kind: "select_card", text: "private material", min: 1, max: 1, options: [{ id: "select:0", label: "private card" }] };
const deck: Deck = { main: [], extra: [], side: [] };

describe("bot progress and recovery", () => {
  it("uses keyed prompt-specific public tokens instead of private hashes", () => {
    const action = { promptId: prompt.promptId, choose: ["select:0"] };
    const diagnostic = actionDiagnostic(0, prompt, action);
    expect(diagnostic.prompt).not.toBe(fingerprint(prompt));
    expect(diagnostic.action).not.toBe(fingerprint([prompt.promptId, action.choose]));
    expect(diagnostic).toEqual(actionDiagnostic(0, prompt, action));
    expect(actionDiagnostic(0, { ...prompt, promptId: "another" }, action).action).not.toBe(diagnostic.action);
  });
  it("detects repeated prompts despite new prompt identifiers", () => {
    const guard = new BotProgress(2);
    guard.observe([state], 0, prompt);
    guard.observe([state], 0, { ...prompt, promptId: "1" });
    expect(() => guard.observe([state], 0, { ...prompt, promptId: "2" })).toThrow("no progress");
  });

  it("allows interactive material progress with an unchanged board", () => {
    const guard = new BotProgress(2);
    for (let i = 0; i < 100; i++) guard.observe([state], 0, {
      ...prompt, options: [{ id: "select:0", label: `material ${i}` }, ...Array.from({ length: i }, (_, j) => ({ id: `unselect:${j}`, label: `selected ${j}` }))],
    });
  });

  it("resets the per-board budget when a long chain advances", () => {
    const guard = new BotProgress(2, 2);
    for (let i = 0; i < 100; i++) guard.observe([{ ...state, chain: [{ card: { uid: `${i}`, owner: 0, controller: 0, location: "mzone", sequence: 0, position: "atk" }, desc: "effect" }] }], 0, prompt);
  });

  it("allows unchanged-board damage windows across multiple attacks", () => {
    const guard = new BotProgress(12);
    const attacker = { uid: "attacker", owner: 0 as const, controller: 0 as const, location: "mzone" as const, sequence: 0, position: "atk" as const };
    for (let attack = 0; attack < 5; attack++) {
      guard.observe([state], 0, prompt, [{ t: "attack", attacker }]);
      for (let window = 0; window < 10; window++) guard.observe([state], 0, prompt);
    }
  });

  it("aborts a looping bot, destroys the duel, and keeps private labels out of diagnostics", async () => {
    const destroy = vi.fn(), errors: ServerMsg[] = [];
    const duel: Duel = { step: async () => ({ events: [], pending: { player: 0, prompt } }), respond: () => {}, stateFor: () => state, redactEvents: events => events, destroy };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const room = new Room(async () => duel, { seed: 42, botRepeatLimit: 2 });
    const seat = (id: string): Participant => ({ id, name: id, kind: "bot", send: msg => errors.push(msg), bot: { name: "loop", choose: () => ({ promptId: prompt.promptId, choose: ["select:0"] }) } });
    try {
      room.join(seat("0"), deck); room.join(seat("1"), deck);
      await room.finished;
      expect(room.status).toBe("done");
      expect(room.winner).toBeUndefined();
      expect(destroy).toHaveBeenCalledOnce();
      expect(errors.some(msg => msg.type === "error" && msg.message.includes("no progress"))).toBe(true);
      expect(JSON.stringify([room.diagnostics, errors, log.mock.calls])).not.toContain("private");
      expect(room.getDiagnosticContext()).toMatchObject({ seed: 42, prompt, states: [state, state] });
      expect(room.diagnostics).not.toHaveProperty("seed");
      expect(log.mock.calls[0]?.[1]).not.toHaveProperty("seed");
      expect(JSON.stringify(log.mock.calls)).not.toContain('"seed":42');
    } finally { await room.close(); log.mockRestore(); }
  });

  it.each([0, 60_000])("close releases a bot with a pending decision and delay %i", async (botDelayMs) => {
    const destroy = vi.fn();
    const impossible: Prompt = { ...prompt, min: 2, max: 2, options: [] };
    const duel: Duel = { step: async () => ({ events: [], pending: { player: 0, prompt: impossible } }), respond: () => {}, stateFor: () => state, redactEvents: events => events, destroy };
    const room = new Room(async () => duel, { botDelayMs });
    const seat = (id: string): Participant => ({ id, name: id, kind: "bot", send: () => {}, bot: { name: "pending", choose: () => new Promise(() => {}) } });
    room.join(seat("0"), deck); room.join(seat("1"), deck);
    await new Promise(resolve => setImmediate(resolve));
    await room.close();
    expect(destroy).toHaveBeenCalledOnce();
    expect(room.diagnostics.failure).toBeUndefined();
  });

  it("retains rejected actions after a bounded fallback succeeds", async () => {
    const choice: Prompt = { ...prompt, options: [{ id: "a", label: "private a" }, { id: "b", label: "private b" }] };
    let accepted = false;
    const messages: ServerMsg[] = [];
    const duel: Duel = {
      step: async () => accepted ? { events: [], ended: { winner: 0, reason: "test" } } : { events: [], pending: { player: 0, prompt: choice } },
      respond: (_player, action) => { if (!action.choose.includes("b")) throw new Error("private rejection detail"); accepted = true; },
      stateFor: () => state, redactEvents: events => events, destroy: () => {},
    };
    const room = new Room(async () => duel);
    const seat = (id: string): Participant => ({ id, name: id, kind: "bot", send: msg => messages.push(msg), bot: { name: "bad", choose: () => ({ promptId: choice.promptId, choose: ["a"] }) } });
    room.join(seat("0"), deck); room.join(seat("1"), deck);
    await room.finished;
    expect(room.winner).toBe(0);
    expect(room.diagnostics.trace.filter(action => action.rejected)).toHaveLength(4);
    expect(room.diagnostics.rejectedActions).toBe(4);
    expect(JSON.stringify(messages)).not.toContain("private");
    await room.close();
  });

  it("clears the 60-second bot-delay and deadline timers immediately on close", async () => {
    vi.useFakeTimers();
    const destroy = vi.fn();
    const duel: Duel = { step: async () => ({ events: [], pending: { player: 0, prompt } }), respond: () => {}, stateFor: () => state, redactEvents: events => events, destroy };
    const room = new Room(async () => duel, { botDelayMs: 60_000 });
    const seat = (id: string): Participant => ({ id, name: id, kind: "bot", send: () => {}, bot: { name: "delayed", choose: () => ({ promptId: prompt.promptId, choose: ["select:0"] }) } });
    try {
      room.join(seat("0"), deck); room.join(seat("1"), deck);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(vi.getTimerCount()).toBe(2);
      await room.close();
      expect(vi.getTimerCount()).toBe(0);
      expect(destroy).toHaveBeenCalledOnce();
    } finally { await room.close(); vi.useRealTimers(); }
  });

  for (const end of ["close", "surrender", "expiry"] as const) it(`releases an impossible human prompt on ${end}`, async () => {
    const impossible: Prompt = { ...prompt, min: 2, max: 2, options: [] };
    const destroy = vi.fn();
    const duel: Duel = { step: async () => ({ events: [], pending: { player: 0, prompt: impossible } }), respond: () => { throw new Error("must not respond"); }, stateFor: () => state, redactEvents: events => events, destroy };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const room = new Room(async () => duel, { turnTimeoutMs: 10 });
    const seat: Participant = { id: "0", name: "0", kind: "human", send: () => {} };
    try {
      room.join(seat, deck); room.join({ ...seat, id: "1" }, deck);
      await new Promise(resolve => setImmediate(resolve));
      if (end === "close") await room.close();
      if (end === "surrender") room.surrender(seat);
      await room.finished;
      expect(room.status).toBe("done");
      expect(destroy).toHaveBeenCalledOnce();
      if (end === "expiry") expect(room.diagnostics.failure).toContain("no acceptable action");
    } finally { await room.close(); log.mockRestore(); }
  });
});
