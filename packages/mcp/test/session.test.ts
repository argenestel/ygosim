import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { CardData, ClientMsg, DuelState, Prompt, ServerMsg } from "@ygosim/protocol";
import { Session, configFromEnv, wsUrlFor } from "../src/tools.js";
import { handleLine } from "../src/cli.js";
import { parseYdk } from "../src/deck.js";

const card: CardData = { code: 89631139, name: "Blue-Eyes White Dragon", desc: "This legendary dragon is a powerful engine of destruction.", type: ["Monster", "Normal"], atk: 3000, def: 2500, level: 8, attribute: "LIGHT", race: "Dragon", imageUrl: "" };
const ref = { uid: "dragon", code: card.code, owner: 0 as const, controller: 0 as const, location: "mzone" as const, sequence: 0, position: "atk" as const, atk: 3000, def: 2500 };
const state: DuelState = { duelId: "duel1", turn: 1, turnPlayer: 0, phase: "main1", lp: [8000, 8000], cards: [ref, { uid: "hidden", owner: 1, controller: 1, location: "hand", sequence: 0, position: "facedown" }], chain: [], you: 0 };
const prompt: Prompt = { promptId: "prompt1", kind: "idle", text: "Choose an action", options: [{ id: "summon:dragon", label: "Summon", card: ref }, { id: "end", label: "End turn" }] };
const deck = { main: [card.code], extra: [], side: [] };

let http: Server, wss: WebSocketServer, peer: WebSocket, session: Session;
let messages: ClientMsg[], requests: string[], autoPrompt: boolean, rejection: boolean, httpStatus: number;
function send(msg: ServerMsg) { peer.send(JSON.stringify(msg)); }
function call(tool: string, args: object = {}) { return handleLine(session, JSON.stringify({ id: 1, tool, args })) as Promise<{ id: number; ok: boolean; text?: string; error?: string }>; }
async function flush() { await new Promise((resolve) => setTimeout(resolve, 20)); }

beforeEach(async () => {
  messages = []; requests = []; autoPrompt = true; rejection = false; httpStatus = 200;
  http = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader("content-type", "application/json");
    res.statusCode = httpStatus;
    if (httpStatus !== 200) return res.end(JSON.stringify({ error: "unavailable" }));
    if (req.url === "/api/rooms") return res.end(JSON.stringify([{ roomId: "room1", players: [{ name: "Yugi", kind: "human" }], status: "waiting", open: true }]));
    if (req.url === "/api/decks") return res.end(JSON.stringify([{ name: "Dragon Starter", deck }]));
    if (req.url?.startsWith("/api/cards?q=")) return res.end(JSON.stringify([card]));
    if (req.url === `/api/cards/${card.code}`) return res.end(JSON.stringify(card));
    res.statusCode = 404; res.end("{}");
  });
  wss = new WebSocketServer({ server: http, path: "/ws" });
  wss.on("error", () => {});
  wss.on("connection", (socket) => {
    peer = socket;
    send({ type: "welcome", clientId: "client1" });
    socket.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as ClientMsg;
      messages.push(msg);
      if (msg.type === "create_room" || msg.type === "join_room") {
        send({ type: "room", roomId: msg.type === "join_room" ? msg.roomId : "room1", players: ["Agent", "AI (hard)"], status: "dueling" });
        if (autoPrompt) {
          send({ type: "events", events: [{ t: "summon", card: ref, kind: "normal" }], state });
          send({ type: "prompt", prompt, state });
        }
      }
      if (msg.type === "action") {
        if (rejection) send({ type: "error", message: "engine rejected action: invalid selection" });
        else {
          send({ type: "events", events: [{ t: "damage", player: 1, amount: 3000, lp: 5000 }], state: { ...state, lp: [8000, 5000] } });
          send({ type: "prompt", prompt: { ...prompt, promptId: "prompt2" }, state: { ...state, lp: [8000, 5000] } });
        }
      }
      if (msg.type === "chat") send({ type: "chat", from: "Agent", text: msg.text });
      if (msg.type === "surrender") {
        send({ type: "events", events: [{ t: "win", winner: 1, reason: "surrender" }], state });
        send({ type: "room", roomId: "room1", players: ["Agent", "AI"], status: "done" });
      }
    });
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("missing server port");
  session = new Session({ baseUrl: `ws://127.0.0.1:${address.port}/ws`, name: "Agent" });
});
afterEach(async () => {
  session?.client.close();
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe("shared tools against a fake game server", () => {
  it("lists actual HTTP player objects and sample names", async () => {
    const result = await call("list_rooms");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Yugi (human)");
    expect(result.text).toContain("Dragon Starter");
    expect(result.text).not.toContain("[object Object]");
  });
  it("creates an AI room with the correct greeting, difficulty, deck and named board", async () => {
    expect((await call("create_room", { deck: "dragon starter", vsAI: true, level: "hard" })).ok).toBe(true);
    expect(session.client.clientId).toBe("client1");
    const result = await call("wait_for_turn", { timeoutSec: 1 });
    expect(messages[0]).toEqual({ type: "hello", name: "Agent", kind: "agent" });
    expect(messages[1]).toEqual({ type: "create_room", vsAI: true, aiLevel: "hard", deck });
    expect(result.text).toContain("normal summoned Blue-Eyes White Dragon");
    expect(result.text).toContain("zone   | card");
    expect(result.text).toContain("1. Summon — Blue-Eyes White Dragon");
    expect(result.text).toContain('id: "summon:dragon"');
    expect(result.text).not.toContain("hidden");
    const again = await call("get_state");
    expect(again.text).not.toContain("normal summoned");
    expect(again.text).toContain("Blue-Eyes White Dragon");
    expect(requests.filter((url) => url === `/api/cards/${card.code}`)).toHaveLength(1);
  });
  it.each([
    [{ ydk: "#created by agent\r\n#main\r\n89631139\r\n#extra\r\n123\r\n!side\r\n456" }, { main: [card.code], extra: [123], side: [456] }],
    [{ main: [card.code], extra: [123], side: [456] }, { main: [card.code], extra: [123], side: [456] }],
  ])("joins with a supplied deck %j", async (args, expected) => {
    expect((await call("join_room", { roomId: "other", ...args })).ok).toBe(true);
    expect(messages[1]).toEqual({ type: "join_room", roomId: "other", deck: expected });
  });
  it("maps displayed numbers to wire ids and waits for the next decision", async () => {
    await call("create_room"); await call("wait_for_turn");
    const result = await call("act", { choose: [1], promptId: "prompt1", timeoutSec: 1 });
    expect(result.ok).toBe(true);
    expect(messages.at(-1)).toEqual({ type: "action", action: { promptId: "prompt1", choose: ["summon:dragon"] } });
    expect(result.text).toContain("Opp took 3000 damage");
    expect(result.text).toContain("prompt2");
    expect((await call("act", { choose: ["end"], wait: false })).text).toBe("Action sent.");
  });
  it("rejects invalid, duplicate, out of bounds and stale actions without consuming the prompt", async () => {
    await call("create_room"); await call("wait_for_turn");
    for (const args of [{ choose: [99] }, { choose: ["missing"] }, { choose: [1, 1] }, { choose: [] }, { choose: [1], promptId: "old" }]) {
      expect((await call("act", { ...args, wait: false })).ok).toBe(false);
      expect(session.client.prompt?.promptId).toBe("prompt1");
    }
    expect(messages.filter((msg) => msg.type === "action")).toHaveLength(0);
  });
  it("supports prompts that allow selecting zero options", async () => {
    await call("create_room"); await call("wait_for_turn");
    send({ type: "prompt", prompt: { ...prompt, min: 0, max: 2 }, state }); await flush();
    expect((await call("act", { choose: [], wait: false })).ok).toBe(true);
    await flush();
    expect(messages.at(-1)).toEqual({ type: "action", action: { promptId: "prompt1", choose: [] } });
  });
  it("restores a rejected action's prompt for retry", async () => {
    rejection = true;
    await call("create_room"); await call("wait_for_turn");
    const result = await call("act", { choose: ["end"], timeoutSec: 1 });
    expect(result.text).toContain("engine rejected action");
    expect(result.text).toContain("Your decision");
    expect(session.client.prompt?.promptId).toBe("prompt1");
  });
  it("does not resurrect a prompt for unrelated chat errors or turn expiry", async () => {
    await call("create_room"); await call("wait_for_turn");
    send({ type: "error", message: "turn timer expired; auto-picked a default action" }); await flush();
    expect(session.client.prompt).toBeNull();
    send({ type: "error", message: "chat unavailable" }); await flush();
    expect((await call("wait_for_turn")).text).not.toContain("Your decision");
  });
  it("long-polls until a delayed prompt and returns timeout without a prompt", async () => {
    autoPrompt = false; await call("create_room");
    expect(await session.client.waitForTurn(10)).toEqual({ kind: "timeout" });
    const waiting = call("wait_for_turn", { timeoutSec: 1 });
    setTimeout(() => send({ type: "prompt", prompt, state }), 25);
    expect((await waiting).text).toContain("Your decision");
  });
  it("unblocks when a waiting connection closes", async () => {
    autoPrompt = false; await call("create_room");
    const waiting = call("wait_for_turn", { timeoutSec: 10 });
    peer.close();
    expect((await waiting).text).toContain("connection closed");
    expect((await call("wait_for_turn", { timeoutSec: 10 })).text).toContain("connection closed");
  });
  it("shows chat, surrender result and clears stale prompts", async () => {
    await call("create_room"); await call("wait_for_turn");
    expect((await call("chat", { text: "Good duel!" })).ok).toBe(true);
    await flush();
    expect((await call("get_state")).text).toContain("Agent: Good duel!");
    await call("surrender");
    const result = await call("wait_for_turn", { timeoutSec: 1 });
    expect(result.text).toContain("you LOST (surrender)");
    expect(result.text).not.toContain("Your decision");
    expect(session.client.prompt).toBeNull();
    expect((await call("create_room")).ok).toBe(true);
  });
  it("preserves the current duel on an accidental second create/join", async () => {
    await call("create_room"); await call("wait_for_turn");
    expect((await call("create_room")).error).toContain("already in a room");
    expect(session.client.prompt?.promptId).toBe("prompt1");
  });
  it("looks up cards by name and passcode and retries temporary HTTP failures", async () => {
    httpStatus = 503;
    expect((await call("card_info", { code: card.code })).error).toContain("503");
    expect((await call("list_rooms")).error).toContain("503");
    httpStatus = 200;
    const info = await call("card_info", { code: card.code });
    expect(info.text).toContain("Blue-Eyes White Dragon");
    expect(info.text).toContain("ATK 3000 / DEF 2500");
    expect((await call("card_info", { name: "Blue-Eyes" })).text).toContain(card.desc);
    expect(requests).toContain("/api/cards?q=Blue-Eyes");
  });
  it("validates JSON-lines requests and uses the same tool schemas", async () => {
    expect(await handleLine(session, " ")).toBeNull();
    for (const input of ["{", "null", "42", "[]", '{"tool":"missing"}', '{"tool":"act","args":{"choose":[-1]}}', '{"tool":"create_room","args":{"level":"expert"}}', '{"tool":"card_info"}']) {
      expect(await handleLine(session, input)).toMatchObject({ ok: false });
    }
    expect(await handleLine(session, '{"id":"help1","tool":"help"}')).toMatchObject({ id: "help1", ok: true, tools: expect.arrayContaining([expect.objectContaining({ name: "surrender" })]) });
  });
  it("rejects ambiguous deck sources and unknown sample names", async () => {
    for (const args of [{ deck: "missing" }, { deck: "Dragon Starter", main: [1] }, { ydk: "#main" }, { extra: [1] }]) expect((await call("create_room", args)).ok).toBe(false);
  });
});

it("uses the default WS URL and derives secure WS and HTTP URLs", () => {
  expect(configFromEnv({})).toEqual({ baseUrl: "ws://localhost:7777", name: "agent" });
  expect(wsUrlFor("https://example.com")).toBe("wss://example.com/ws");
  expect(new Session({ baseUrl: "wss://example.com/ws/", name: "agent" }).http).toBe("https://example.com");
  expect(wsUrlFor("ws://example.com/ws")).toBe("ws://example.com/ws");
});
it("parses YDK comments and sections", () => {
  expect(parseYdk("#created by agent\n#main\n1\n#extra\n2\n!side\n3")).toEqual({ main: [1], extra: [2], side: [3] });
});
