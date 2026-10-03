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
let searchCards: CardData[], banlist: Record<number, 0 | 1 | 2>, banlistAvailable: boolean;
let messages: ClientMsg[], requests: string[], autoPrompt: boolean, rejection: boolean, httpStatus: number;
function send(msg: ServerMsg) { peer.send(JSON.stringify(msg)); }
function call(tool: string, args: object = {}) { return handleLine(session, JSON.stringify({ id: 1, tool, args })) as Promise<{ id: number; ok: boolean; text?: string; error?: string }>; }
async function flush() { await new Promise((resolve) => setTimeout(resolve, 20)); }

beforeEach(async () => {
  searchCards = [card]; banlist = { 1: 0, 2: 1, 3: 2 }; banlistAvailable = true;
  messages = []; requests = []; autoPrompt = true; rejection = false; httpStatus = 200;
  http = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader("content-type", "application/json");
    res.statusCode = httpStatus;
    if (httpStatus !== 200) return res.end(JSON.stringify({ error: "unavailable" }));
    if (req.url === "/api/rooms") return res.end(JSON.stringify([{ roomId: "room1", players: [{ name: "Yugi", kind: "human" }], status: "waiting", open: true }]));
    if (req.url === "/api/decks") return res.end(JSON.stringify([{ name: "Dragon Starter", deck }]));
    if (req.url?.startsWith("/api/cards?q=")) {
      const params = new URL(req.url, "http://localhost").searchParams;
      const q = params.get("q")!.toLowerCase();
      const matches = searchCards.filter(c => c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q));
      return res.end(JSON.stringify({ cards: matches.slice(0, Number(params.get("limit") ?? 50)), total: matches.length }));
    }
    if (req.url === "/api/banlist/tcg") {
      if (!banlistAvailable) { res.statusCode = 503; return res.end("{}"); }
      return res.end(JSON.stringify(banlist));
    }
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
  it("explains weighted constraints and rejects insufficient tributes without consuming the prompt", async () => {
    await call("create_room"); await call("wait_for_turn");
    const tribute: Prompt = { promptId: "tribute", kind: "select_tribute", text: "Select tributes", min: 1, max: 2,
      options: ["a", "b", "double", "cancel"].map(id => ({ id, label: id })),
      constraints: { kind: "tribute", required: 2, values: { a: 1, b: 1, double: 2 }, cancel: "cancel" } };
    send({ type: "prompt", prompt: tribute, state }); await flush();
    expect((await call("get_state")).text).toContain('"required":2');
    expect((await call("act", { choose: ["a"], wait: false })).error).toContain("need at least 2");
    expect(session.client.prompt?.promptId).toBe("tribute");
    expect(messages.filter(msg => msg.type === "action")).toHaveLength(0);
    expect((await call("act", { choose: ["a", "b"], wait: false })).ok).toBe(true);
    await flush();
    send({ type: "prompt", prompt: tribute, state }); await flush();
    expect((await call("act", { choose: ["double"], wait: false })).ok).toBe(true);
    await flush();
    send({ type: "prompt", prompt: tribute, state }); await flush();
    expect((await call("act", { choose: ["cancel"], wait: false })).ok).toBe(true);
  });

  it("validates mandatory sums and atomic interactive finish/cancel actions", async () => {
    await call("create_room"); await call("wait_for_turn");
    send({ type: "prompt", state, prompt: { promptId: "sum", kind: "select_sum", text: "Sum", min: 0, max: 1,
      options: [{ id: "a", label: "a" }], constraints: { kind: "sum", target: 8, mode: "exact", mandatory: [[2, 4]], values: { a: [4, 6] } } } });
    await flush();
    expect((await call("act", { choose: [], wait: false })).ok).toBe(false);
    expect((await call("act", { choose: ["a"], wait: false })).ok).toBe(true);
    await flush();
    send({ type: "prompt", state, prompt: { promptId: "interactive", kind: "select_card", text: "Select", min: 0, max: 3,
      options: ["select:0", "unselect:0", "finish", "cancel"].map(id => ({ id, label: id })),
      constraints: { kind: "interactive", actions: { "select:0": "select", "unselect:0": "unselect", finish: "finish", cancel: "cancel" } } } });
    await flush();
    expect((await call("act", { choose: [], wait: false })).ok).toBe(false);
    expect((await call("act", { choose: ["finish", "cancel"], wait: false })).ok).toBe(false);
    expect((await call("act", { choose: ["finish"], wait: false })).ok).toBe(true);
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

describe("card_info deck-building query", () => {
  beforeEach(() => {
    searchCards = Array.from({ length: 45 }, (_, i) => ({ ...card, code: i + 1, name: `HERO Fighter ${i}`, desc: "Draw two cards when summoned." }));
  });
  it("returns 40 compact archetype matches with all TCG statuses", async () => {
    const result = await call("card_info", { query: "HERO" });
    expect(result.ok).toBe(true);
    expect(result.text!.split("\n")).toHaveLength(40);
    expect(result.text).toContain("1 | HERO Fighter 0 | Monster/Normal | Level/Rank 8 / ATK 3000 | TCG Forbidden");
    expect(result.text).toContain("TCG Limited");
    expect(result.text).toContain("TCG Semi-Limited");
    expect(result.text).toContain("TCG Unlimited");
    expect(result.text).not.toContain("Draw two cards");
    expect(requests).toContain("/api/cards?q=HERO&limit=40");
  });
  it("searches a name substring with a smaller limit", async () => {
    const result = await call("card_info", { query: "fighter 1", limit: 3 });
    expect(result.text!.split("\n")).toHaveLength(3);
    expect(result.text).toContain("HERO Fighter 1 |");
    expect(requests).toContain("/api/cards?q=fighter%201&limit=3");
  });
  it("searches effect text and tolerates an unavailable banlist", async () => {
    banlistAvailable = false;
    const result = await call("card_info", { query: "draw two cards" });
    expect(result.ok).toBe(true);
    expect(result.text!.split("\n")).toHaveLength(40);
    expect(result.text).toContain("TCG status unknown");
    expect(requests).toContain("/api/cards?q=draw%20two%20cards&limit=40");
  });
  it("reports the TCG status for forbidden and limited real cards", async () => {
    banlist = { 55144522: 0, 85115440: 0, 78872731: 1, 24224830: 1 };
    searchCards = [
      { ...card, code: 55144522, name: "Pot of Greed", desc: "status marker" },
      { ...card, code: 85115440, name: "Zoodiac Broadbull", desc: "status marker" },
      { ...card, code: 78872731, name: "Zoodiac Ratpier", desc: "status marker" },
      { ...card, code: 24224830, name: "Called by the Grave", desc: "status marker" },
    ];
    const result = await call("card_info", { query: "status marker" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("55144522 | Pot of Greed | Monster/Normal | Level/Rank 8 / ATK 3000 | TCG Forbidden");
    expect(result.text).toContain("85115440 | Zoodiac Broadbull | Monster/Normal | Level/Rank 8 / ATK 3000 | TCG Forbidden");
    expect(result.text).toContain("78872731 | Zoodiac Ratpier | Monster/Normal | Level/Rank 8 / ATK 3000 | TCG Limited");
    expect(result.text).toContain("24224830 | Called by the Grave | Monster/Normal | Level/Rank 8 / ATK 3000 | TCG Limited");
  });
  it("keeps name lookups at five full-text results and passcodes unchanged", async () => {
    const result = await call("card_info", { name: "HERO" });
    expect(result.text!.split("\n\n")).toHaveLength(5);
    expect(result.text).toContain("Draw two cards when summoned.");
    expect(requests).toEqual(["/api/cards?q=HERO"]);
    const exact = await call("card_info", { code: card.code });
    expect(exact.text).toContain(card.desc);
    expect(exact.text).toContain("ATK 3000 / DEF 2500");
  });
  it("rejects out-of-range limits and reports no matches", async () => {
    for (const limit of [0, 41, 1.5]) expect((await call("card_info", { query: "HERO", limit })).ok).toBe(false);
    expect((await call("card_info", { query: "nonexistent" })).text).toBe("No card found.");
  });
});
