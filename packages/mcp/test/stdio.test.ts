import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const http = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/decks") res.end(JSON.stringify([{ name: "Test Starter", deck: { main: [89631139], extra: [], side: [] } }]));
  else if (req.url === "/api/cards/89631139" || req.url?.startsWith("/api/cards?q=")) {
    const card = { code: 89631139, name: "Blue-Eyes White Dragon", desc: "A legendary dragon.", type: ["Monster", "Normal"], imageUrl: "" };
    res.end(JSON.stringify(req.url.includes("q=") ? [card] : card));
  } else res.end("[]");
});
const wss = new WebSocketServer({ server: http, path: "/ws" });
wss.on("error", () => {});
wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "welcome", clientId: "stdio-agent" }));
  socket.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "create_room") socket.send(JSON.stringify({ type: "room", roomId: "stdio-room", players: ["Agent"], status: "waiting" }));
  });
});
const inMemory = process.env.YGOSIM_TEST_IN_MEMORY === "1";
let baseUrl = "ws://localhost:7777";
// Node's spawned stdio uses socketpairs on Linux. Restricted sandboxes can
// allow ordinary pipes while blocking those sockets; shell cat supplies pipes.
const executable = (entry: string) => inMemory
  ? { command: "/bin/sh", args: ["-c", `cat | node dist/${entry}.js | cat`] }
  : { command: process.execPath, args: [`dist/${entry}.js`] };
beforeAll(async () => {
  // Exercise generated executable shims rather than only importing the source modules.
  await promisify(execFile)(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], { cwd: packageDir });
  await promisify(execFile)(process.execPath, ["scripts/shims.mjs"], { cwd: packageDir });
  if (inMemory) return;
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  baseUrl = `ws://127.0.0.1:${address.port}`;
}, 15000);
afterAll(async () => {
  if (inMemory) return;
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

it("initializes the stdio MCP server, lists all tools, calls them, and reports errors", async () => {
  const transport = new StdioClientTransport({ ...executable("index"), cwd: packageDir, env: { ...process.env as Record<string, string>, YGOSIM_URL: baseUrl }, stderr: "pipe" });
  const client = new Client({ name: "test", version: "1.0.0" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  try {
    try { await client.connect(transport); } catch (error) { throw new Error(`${error}; stderr: ${stderr}`); }
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["list_rooms", "create_room", "join_room", "wait_for_turn", "get_state", "act", "card_info", "chat", "surrender"].sort());
    if (!inMemory) {
    expect(await client.callTool({ name: "card_info", arguments: { name: "Blue-Eyes" } })).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Blue-Eyes White Dragon") }] });
    expect(await client.callTool({ name: "create_room", arguments: {} })).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("stdio-room") }] });
    }
    expect(await client.callTool({ name: "act", arguments: { choose: [1], wait: false } })).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("no pending prompt") }] });
    expect(stderr).toBe("");
  } finally { await client.close(); }
});

it.skipIf(inMemory)("runs the JSON-lines executable with ordered responses and clean shutdown", async () => {
  const child: ChildProcessWithoutNullStreams = spawn(executable("cli").command, executable("cli").args, { cwd: packageDir, env: { ...process.env, YGOSIM_URL: baseUrl } });
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { errors += String(chunk); });
  const exited = once(child, "close");
  child.stdin.end([
    '{"id":1,"tool":"help"}',
    'null',
    '{"id":2,"tool":"create_room","args":{"vsAI":false}}',
    '{"id":3,"tool":"get_state"}',
    '{"id":4,"tool":"card_info","args":{"name":"Blue-Eyes"}}',
  ].join("\n") + "\n");
  try {
    expect((await exited)[0]).toBe(0);
    const lines = output.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatchObject({ id: 1, ok: true, tools: expect.any(Array) });
    expect(lines[1]).toMatchObject({ ok: false });
    expect(lines[2]).toMatchObject({ id: 2, ok: true, text: expect.stringContaining("stdio-room") });
    expect(lines[3]).toMatchObject({ id: 3, ok: true });
    expect(lines[4]).toMatchObject({ id: 4, ok: true, text: expect.stringContaining("Blue-Eyes White Dragon") });
    expect(errors).toBe("");
  } finally { if (child.exitCode === null) child.kill(); }
});

it("keeps the JSON-lines process alive after malformed input without game networking", async () => {
  const child = spawn(executable("cli").command, executable("cli").args, { cwd: packageDir });
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { errors += String(chunk); });
  const exited = once(child, "close");
  child.stdin.end('{"id":1,"tool":"help"}\nnull\n{\n{"id":2,"tool":"get_state"}\n');
  try {
    expect((await exited)[0]).toBe(0);
    const lines = output.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ ok: true, tools: expect.any(Array) });
    expect(lines[1]).toMatchObject({ ok: false });
    expect(lines[2]).toMatchObject({ ok: false, error: "invalid JSON" });
    expect(lines[3]).toMatchObject({ id: 2, ok: true, text: "No duel state yet." });
    expect(errors).toBe("");
  } finally { if (child.exitCode === null) child.kill(); }
});
