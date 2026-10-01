// Optional restricted-environment transport: same JSON frames and HTTP routes,
// delivered in memory when local socket listeners are unavailable.
import { EventEmitter } from "node:events";
import { beforeEach, vi } from "vitest";

const memory = vi.hoisted(() => ({ enabled: process.env.YGOSIM_TEST_IN_MEMORY === "1" }));
const servers = new Map<number, MemoryHttp>();
let nextPort = 10000;
class MemoryHttp extends EventEmitter {
  port = nextPort++;
  listening = false;
  constructor(public handler: (req: { url: string }, res: MemoryResponse) => void) { super(); }
  listen() { servers.set(this.port, this); this.listening = true; queueMicrotask(() => this.emit("listening")); return this; }
  address() { return { port: this.port }; }
  closeAllConnections() {}
  close(callback: () => void) { servers.delete(this.port); this.listening = false; queueMicrotask(callback); }
}
class MemoryResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  constructor(private resolve: (response: Response) => void) {}
  setHeader(key: string, value: string) { this.headers[key] = value; }
  end(body = "") { this.resolve(new Response(body, { status: this.statusCode, headers: this.headers })); }
}
const sockets = new Map<MemoryHttp, MemoryWss>();
class MemorySocket extends EventEmitter {
  static OPEN = 1;
  readonly OPEN = 1;
  readyState = 0;
  peer?: MemorySocket;
  constructor(url?: string) {
    super();
    if (url) queueMicrotask(() => {
      const u = new URL(url);
      const server = servers.get(Number(u.port));
      const wss = server && sockets.get(server);
      if (!wss || u.pathname !== wss.path) {
        this.emit("error", new Error("connection refused")); this.close(); return;
      }
      const peer = new MemorySocket();
      this.peer = peer; peer.peer = this;
      this.readyState = peer.readyState = this.OPEN;
      wss.clients.add(peer);
      peer.once("close", () => wss.clients.delete(peer));
      this.emit("open");
      wss.emit("connection", peer);
    });
  }
  send(data: string) { queueMicrotask(() => { if (this.peer?.readyState === this.OPEN) this.peer.emit("message", Buffer.from(data)); }); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const peer = this.peer;
    if (peer) peer.readyState = 3;
    queueMicrotask(() => { this.emit("close"); peer?.emit("close"); });
  }
  terminate() { this.close(); }
}
class MemoryWss extends EventEmitter {
  clients = new Set<MemorySocket>();
  path: string;
  server: MemoryHttp;
  constructor(options: { server: MemoryHttp; path: string }) { super(); this.path = options.path; this.server = options.server; sockets.set(this.server, this); }
  close(callback: () => void) { sockets.delete(this.server); queueMicrotask(callback); }
}
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  return memory.enabled ? { ...actual, createServer: (handler: MemoryHttp["handler"]) => new MemoryHttp(handler) } : actual;
});
vi.mock("ws", async (original) => memory.enabled ? { default: MemorySocket, WebSocket: MemorySocket, WebSocketServer: MemoryWss } : original());
beforeEach(() => {
  if (!memory.enabled) return;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    const u = new URL(input);
    const server = servers.get(Number(u.port));
    if (!server) throw new Error("connection refused");
    return new Promise<Response>((resolve) => server.handler({ url: u.pathname + u.search }, new MemoryResponse(resolve)));
  });
});
