import type { CardDb, ClientMsg, Deck, FormatId, ServerMsg, PlayerIdx, OpponentSpec } from "@ygosim/protocol";
import { createBot } from "./ai/index.js";
import { Room, type CreateDuel, type Participant, type RoomOptions } from "./room.js";
import { validateDeck } from "./decks.js";
import type { EngineApi } from "./engine.js";

export interface Session extends Participant { room?: Room; hello: boolean; disconnected?: boolean; busy?: boolean; }

let clientCounter = 0;

/** Transport-agnostic lobby: feed it ClientMsgs, it routes to rooms. */
export class Lobby {
  readonly rooms = new Map<string, Room>();
  private readonly agentRooms = new WeakSet<Room>();
  constructor(
    private createDuel: CreateDuel,
    private roomOpts: RoomOptions = {},
    private aiDeck?: () => Deck | undefined,
    private getEngine?: () => EngineApi | null,
    private getDbReady?: () => Promise<CardDb | null>,
    private maxRooms = 100,
  ) {}

  get tournamentLimits() {
    return { decisionTimeoutMs: this.roomOpts.turnTimeoutMs ?? 180_000, maxInvalid: this.roomOpts.maxInvalid ?? 5 };
  }

  connect(send: (m: ServerMsg) => void): Session {
    const s: Session = { id: `c${++clientCounter}`, name: `player${clientCounter}`, kind: "human", send, hello: false };
    send({ type: "welcome", clientId: s.id });
    return s;
  }

  disconnect(s: Session) {
    s.disconnected = true;
    s.room?.leave(s);
    s.room = undefined;
    this.gc();
  }

  private async validateDeckAsync(deck: Deck, format: FormatId): Promise<{ ok: boolean; errors: string[] }> {
    const engine = this.getEngine?.();
    if (engine) {
      // Engine is loaded: must wait for database and enforce validation
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const db = await Promise.race([
          this.getDbReady?.() ?? Promise.resolve(null),
          new Promise<null>((_, reject) => (timer = setTimeout(() => reject(new Error("database load timeout")), 10000))),
        ]);
        if (!db) {
          return { ok: false, errors: ["card database loading, please retry"] };
        }
        return await engine.validateDeck(deck, format, db);
      } catch (e) {
        console.warn(`[lobby] engine validateDeck failed for format ${format}:`, e);
        // Never fall back to local check when engine is loaded - report error
        return { ok: false, errors: [`validation error: ${(e as Error).message}`] };
      } finally {
        clearTimeout(timer);
      }
    }
    // Engine not loaded: use local validation (format-agnostic)
    return validateDeck(deck);
  }

  async handle(s: Session, raw: unknown) {
    if (s.disconnected) return;
    const mutating = !!raw && typeof raw === "object" && ["create_room", "join_room", "side_deck", "spectate"].includes((raw as ClientMsg).type);
    if (mutating && s.busy) return s.send({ type: "error", message: "room request already pending" });
    if (mutating) s.busy = true;
    if (mutating && s.room?.status === "done" && (raw as ClientMsg).type !== "side_deck") {
      s.room.spectators.delete(s);
      s.room = undefined;
      this.gc();
    }
    try { await this.dispatch(s, raw); }
    finally { if (mutating) s.busy = false; }
  }

  private async dispatch(s: Session, raw: unknown) {
    const msg = raw as ClientMsg;
    const err = (message: string) => s.send({ type: "error", message });
    if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") return err("malformed message");
    if (!validMessage(msg)) return err("malformed message");
    switch (msg.type) {
      case "hello":
        s.name = String(msg.name || s.name).slice(0, 32);
        s.kind = msg.kind === "agent" ? "agent" : "human";
        s.hello = true;
        return;
      case "create_room": {
        if (s.room && s.room.status !== "done") return err("already in a room");
        const format = msg.format ?? "tcg";
        const match = msg.match ?? "single";

        // Validate deck BEFORE creating room (enforced validation)
        const validation = await this.validateDeckAsync(msg.deck, format);
        if (s.disconnected) return;
        if (!validation.ok) return err(`invalid deck: ${validation.errors.join("; ")}`);
        if (msg.opponentDeck) {
          const opponentValidation = await this.validateDeckAsync(msg.opponentDeck, format);
          if (s.disconnected) return;
          if (!opponentValidation.ok) return err(`invalid opponent deck: ${opponentValidation.errors.join("; ")}`);
        }
        this.gc();
        if (this.rooms.size >= this.maxRooms) return err("server room limit reached; retry later");

        // Create room only after validation passes
        const room = new Room(this.createDuel, { ...this.roomOpts, ...(msg.tournament?.seed !== undefined ? { seed: msg.tournament.seed } : {}) }, undefined, format, match, msg.tournament);
        this.rooms.set(room.id, room);
        if (msg.spectateOnly || msg.opponent && msg.opponent.kind !== "bot") this.agentRooms.add(room);

        // Handle spectateOnly mode (creator is a spectator)
        if (msg.spectateOnly) {
          // In spectate-only mode, the creator watches as a spectator
          // opponentDeck is used for the agent/bot opponent
          const opponentDeck = msg.opponentDeck ?? msg.deck;
          const opponent = msg.opponent ?? { kind: "bot", level: "normal" };

          // Set up the opponent in seat 0
          if (opponent.kind === "bot") {
            const bot = createBot(opponent.level ?? "normal");
            room.join({ id: `bot-${room.id}`, name: `AI (${opponent.level ?? "normal"})`, kind: "bot", bot, send: () => {} }, opponentDeck);
          }

          // Creator joins as spectator
          room.spectators.add(s);
          s.room = room;
          room.broadcastRoom();
          return;
        }

        // Normal mode: creator plays
        s.room = room;
        room.join(s, msg.deck);

        // Handle opponent (agent or bot)
        if (msg.opponent) {
          const opponent = msg.opponent;
          if (opponent.kind === "bot") {
            const bot = createBot(opponent.level ?? "normal");
            room.join({ id: `bot-${room.id}`, name: `AI (${opponent.level ?? "normal"})`, kind: "bot", bot, send: () => {} }, this.aiDeck?.() ?? msg.deck);
          }
        } else if (msg.vsAI) {
          // Legacy vsAI field
          const level = msg.aiLevel ?? "normal";
          const bot = createBot(level);
          room.join({ id: `bot-${room.id}`, name: `AI (${level})`, kind: "bot", bot, send: () => {} }, this.aiDeck?.() ?? msg.deck);
        }
        return;
      }
      case "join_room": {
        if (s.room && s.room.status !== "done") return err("already in a room");
        const room = this.rooms.get(msg.roomId);
        if (!room) return err(`no such room ${msg.roomId}`);
        if (this.agentRooms.has(room) && s.kind !== "agent") return err("this room is waiting for a connected agent");

        // Check if room is full or not waiting
        if (room.isFull) return err("room is full");
        if (room.status !== "waiting") return err("room is not waiting");

        // Validate deck BEFORE joining (enforced validation)
        const validation = await this.validateDeckAsync(msg.deck, room.format);
        if (s.disconnected) return;
        if (!validation.ok) return err(`invalid deck: ${validation.errors.join("; ")}`);

        // Re-check room state after async validation (guard against race)
        if (room.isFull || room.status !== "waiting") return err("room is no longer available");

        // Join only after validation passes
        s.room = room;
        room.join(s, msg.deck);
        return;
      }
      case "spectate": {
        if (s.room && s.room.status !== "done") return err("already in a room");
        const room = this.rooms.get(msg.roomId);
        if (!room) return err(`no such room ${msg.roomId}`);

        s.room = room;
        room.spectators.add(s);
        room.broadcastRoom();
        return;
      }
      case "side_deck":
        if (!s.room) return err("not in a room");
        if (s.room.status !== "siding") return err("not in siding phase");

        // Validate side deck BEFORE accepting (enforced validation)
        const validation = await this.validateDeckAsync(msg.deck, s.room.format);
        if (s.disconnected) return;
        if (!validation.ok) return err(`invalid side deck: ${validation.errors.join("; ")}`);

        // Accept only after validation passes
        s.room.submitSideDeck(s, msg.deck);
        return;
      case "action":
        if (!s.room) return err("not in a room");
        return s.room.submit(s, msg.action);
      case "chat":
        if (!s.room) return err("not in a room");
        return s.room.chat(s, msg.text);
      case "surrender":
        if (!s.room) return err("not in a room");
        return s.room.surrender(s);
      case "adjudicate":
        if (!s.room || !s.room.adjudicate(msg.controlToken, msg.winner, msg.reason)) return err("tournament adjudication denied");
        return;
      default:
        return err(`unknown message type ${(msg as { type: string }).type}`);
    }
  }

  list() {
    return [...this.rooms.values()].map((r) => {
      const playerNames = r.players.map((p) => p.name);
      const result: any = {
        roomId: r.id,
        status: r.status,
        players: playerNames,
        playerKinds: r.players.map((p) => p.kind),
        spectators: r.spectators.size,
        open: r.status === "waiting" && !r.isFull && !this.agentRooms.has(r),
      };
      if (r.format) result.format = r.format;
      if (r.match) result.match = r.match;
      if (r.match === "match") {
        result.score = r.score;
        result.game = r.game;
      }
      return result;
    });
  }

  private gc() {
    for (const [id, r] of this.rooms) {
      const humans = [...r.players, ...r.spectators].filter((p) => p.kind !== "bot" && "hello" in p && !(p as Session).disconnected && (p as Session).room === r);
      if (r.status === "waiting" && (r.players.length === 0 || humans.length === 0)) this.rooms.delete(id);
      if (r.status === "done" && humans.length === 0) this.rooms.delete(id);
    }
  }
}

function validMessage(msg: ClientMsg): boolean {
  const deck = (value: Deck) => !!value && ["main", "extra", "side"].every(key => {
    const cards = value[key as keyof Deck];
    return Array.isArray(cards) && cards.length <= 60 && cards.every(code => Number.isSafeInteger(code) && code > 0);
  });
  const roomId = (value: string) => typeof value === "string" && value.length > 0 && value.length <= 64;
  const level = (value: unknown) => value === undefined || ["easy", "normal", "hard"].includes(value as string);
  const controlToken = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  switch (msg.type) {
    case "hello": return typeof msg.name === "string" && msg.name.length <= 32 && ["human", "agent"].includes(msg.kind);
    case "create_room": return deck(msg.deck) && (!msg.opponentDeck || deck(msg.opponentDeck))
      && (msg.format === undefined || typeof msg.format === "string" && msg.format.length <= 64)
      && (msg.match === undefined || ["single", "match"].includes(msg.match))
      && (msg.vsAI === undefined || typeof msg.vsAI === "boolean")
      && (msg.spectateOnly === undefined || typeof msg.spectateOnly === "boolean") && level(msg.aiLevel)
      && (msg.tournament === undefined || !!msg.tournament && controlToken(msg.tournament.controlToken)
        && (msg.tournament.seed === undefined || Number.isInteger(msg.tournament.seed) && msg.tournament.seed >= 0 && msg.tournament.seed <= 0xffffffff)
        && (msg.match === undefined || msg.match === "single") && !msg.vsAI && !msg.opponent && !msg.spectateOnly)
      && (msg.opponent === undefined || !!msg.opponent && ["bot", "claude", "codex"].includes(msg.opponent.kind) && level(msg.opponent.level));
    case "join_room": return roomId(msg.roomId) && deck(msg.deck);
    case "spectate": return roomId(msg.roomId);
    case "side_deck": return deck(msg.deck);
    case "action": return !!msg.action && typeof msg.action.promptId === "string" && msg.action.promptId.length <= 128
      && Array.isArray(msg.action.choose) && msg.action.choose.length <= 256
      && msg.action.choose.every(id => typeof id === "string" && id.length <= 128);
    case "chat": return typeof msg.text === "string" && msg.text.length > 0 && msg.text.length <= 500;
    case "surrender": return true;
    case "adjudicate": return controlToken(msg.controlToken) && [0, 1, null].includes(msg.winner)
      && ["timeout", "agent-crash"].includes(msg.reason);
    default: return true;
  }
}
