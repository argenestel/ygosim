import WebSocket from "ws";
import { validateSelection } from "@ygosim/protocol";
import type { ClientMsg, Deck, DuelEvent, DuelState, Prompt, ServerMsg } from "@ygosim/protocol";

export interface RoomInfo { roomId: string; players: string[]; status: Extract<ServerMsg, { type: "room" }>["status"] }
export type WaitResult =
  | { kind: "prompt"; prompt: Prompt }
  | { kind: "ended"; winner: 0 | 1 | null; reason: string }
  | { kind: "error"; message: string; prompt: Prompt | null }
  | { kind: "timeout" };

/** One agent's WebSocket session. All state comes from the viewer-redacted wire contract. */
export class GameClient {
  ws?: WebSocket;
  clientId?: string;
  room?: RoomInfo;
  state?: DuelState;
  prompt: Prompt | null = null;
  lastPrompt: Prompt | null = null;
  ended: { winner: 0 | 1 | null; reason: string } | null = null;
  unreadEvents: DuelEvent[] = [];
  unreadChat: { from: string; text: string }[] = [];
  unreadErrors: string[] = [];
  private listeners = new Set<(m: ServerMsg) => void>();
  private connecting?: Promise<void>;
  private pendingAction = false;

  constructor(public wsUrl: string, public name = "agent") {}
  get connected() { return this.ws?.readyState === WebSocket.OPEN; }

  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.connected) return;
    this.connecting = this.open();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }

  private async open(): Promise<void> {
    this.clientId = undefined;
    const ws = new WebSocket(this.wsUrl, { handshakeTimeout: 5000 });
    this.ws = ws;
    ws.on("message", (raw) => {
      let m: ServerMsg;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m && typeof m === "object" && typeof m.type === "string") this.handle(m);
    });
    ws.on("error", () => {}); // Errors also cause close; keep an error listener after handshake.
    ws.on("close", () => {
      this.prompt = this.lastPrompt = null;
      this.pendingAction = false;
      this.handle({ type: "error", message: "connection closed" });
    });
    // The game server sends welcome immediately on connection, before hello.
    const welcome = this.next((m) => m.type === "welcome", 5000);
    const opened = new Promise<void>((resolve, reject) => {
      ws.once("open", () => { this.send({ type: "hello", name: this.name, kind: "agent" }); resolve(); });
      ws.once("error", reject);
      ws.once("close", () => reject(new Error("connection closed")));
    });
    try { await Promise.all([opened, welcome]); }
    catch (e) { ws.terminate(); throw e; }
  }

  close() { this.ws?.close(); }
  send(m: ClientMsg) {
    if (!this.connected) throw new Error("not connected to server");
    this.ws!.send(JSON.stringify(m));
  }
  private emit(m: ServerMsg) { for (const l of [...this.listeners]) l(m); }

  private handle(m: ServerMsg) {
    switch (m.type) {
      case "welcome": this.clientId = m.clientId; break;
      case "room":
        this.room = { roomId: m.roomId, players: m.players, status: m.status };
        if (m.status === "done" && !this.ended) this.ended = { winner: null, reason: "room closed" };
        if (m.status === "done") this.prompt = this.lastPrompt = null;
        break;
      case "events":
        this.state = m.state;
        this.unreadEvents.push(...m.events);
        this.pendingAction = false;
        
        let hasWin = false;
        for (const e of m.events) if (e.t === "win") {
          hasWin = true;
          this.ended = { winner: e.winner, reason: e.reason };
          this.prompt = this.lastPrompt = null;
        }
        
        // Only save the current prompt as lastPrompt if there's no win event.
        // If the duel ends, we should not retain the stale prompt.
        if (!hasWin) {
          this.lastPrompt = this.prompt;
        }
        break;
      case "prompt":
        this.state = m.state;
        this.prompt = this.lastPrompt = m.prompt;
        this.pendingAction = false;
        break;
      case "chat": this.unreadChat.push({ from: m.from, text: m.text }); break;
      case "error":
        this.unreadErrors.push(m.message);
        if (this.pendingAction && /(?:illegal action|rejected action|not your decision)/i.test(m.message)) this.prompt = this.lastPrompt;
        if (/turn timer expired/i.test(m.message)) this.prompt = this.lastPrompt = null;
        this.pendingAction = false;
        break;
    }
    this.emit(m);
  }

  /** Subscribe before sending a request so immediate responses cannot be missed. */
  next(pred: (m: ServerMsg) => boolean, timeoutMs: number): Promise<ServerMsg> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(listener); };
      const listener = (m: ServerMsg) => {
        if (m.type === "error") {
          cleanup();
          const index = this.unreadErrors.indexOf(m.message);
          if (index >= 0) this.unreadErrors.splice(index, 1);
          reject(new Error(m.message));
        } else if (pred(m)) { cleanup(); resolve(m); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error("timed out waiting for server")); }, timeoutMs);
      this.listeners.add(listener);
    });
  }

  private resetDuel() {
    this.state = undefined; this.prompt = this.lastPrompt = null; this.ended = null;
    this.pendingAction = false;
    this.unreadEvents = []; this.unreadErrors = []; this.unreadChat = [];
  }

  private async prepareRoom() {
    if (this.room && this.room.status !== "done") throw new Error("already in a room; finish the current duel first");
    await this.connect();
    this.resetDuel();
  }
  async createRoom(deck: Deck, vsAI: boolean, aiLevel?: "easy" | "normal" | "hard"): Promise<RoomInfo> {
    await this.prepareRoom();
    const response = this.next((m) => m.type === "room", 10000);
    this.send({ type: "create_room", vsAI, aiLevel, deck });
    await response;
    return this.room!;
  }
  async joinRoom(roomId: string, deck: Deck): Promise<RoomInfo> {
    await this.prepareRoom();
    const response = this.next((m) => m.type === "room" && m.roomId === roomId, 10000);
    this.send({ type: "join_room", roomId, deck });
    await response;
    return this.room!;
  }

  waitForTurn(timeoutMs: number): Promise<WaitResult> {
    const check = (): WaitResult | null => {
      if (this.unreadErrors.length) return { kind: "error", message: this.unreadErrors.splice(0).join("; "), prompt: this.prompt };
      if (this.ended) return { kind: "ended", ...this.ended };
      if (!this.connected) return { kind: "error", message: "connection closed", prompt: null };
      if (this.prompt) return { kind: "prompt", prompt: this.prompt };
      return null;
    };
    const now = check();
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = (result: WaitResult) => { clearTimeout(timer); this.listeners.delete(listener); resolve(result); };
      const listener = () => { const result = check(); if (result) done(result); };
      const timer = setTimeout(() => done({ kind: "timeout" }), timeoutMs);
      this.listeners.add(listener);
    });
  }

  act(choose: (string | number)[], promptId?: string) {
    const p = this.prompt;
    if (!p) throw new Error("no pending prompt; call wait_for_turn first");
    if (promptId !== undefined && promptId !== p.promptId) throw new Error("stale promptId; call get_state for the current prompt");
    const selected = choose.map((choice) => {
      if (typeof choice === "string") return choice;
      const option = p.options[choice - 1];
      if (!Number.isInteger(choice) || !option) throw new Error(`invalid option number ${choice}`);
      return option.id;
    });
    const ids = new Set(p.options.map((o) => o.id));
    const bad = selected.filter((id) => !ids.has(id));
    if (bad.length) throw new Error(`invalid option id(s) ${bad.join(", ")}; valid: ${[...ids].join(", ")}`);
    const validity = validateSelection(p, selected);
    if (!validity.valid) throw new Error(validity.reason);
    this.send({ type: "action", action: { promptId: p.promptId, choose: selected } });
    this.pendingAction = true;
    this.prompt = null;
  }
  drainEvents(): DuelEvent[] { return this.unreadEvents.splice(0); }
  drainChat() { return this.unreadChat.splice(0); }
}
