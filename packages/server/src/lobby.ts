import type { CardDb, ClientMsg, Deck, FormatId, ServerMsg, PlayerIdx, OpponentSpec } from "@ygosim/protocol";
import { createBot } from "./ai/index.js";
import { Room, type CreateDuel, type Participant, type RoomOptions } from "./room.js";
import { validateDeck } from "./decks.js";
import type { EngineApi } from "./engine.js";

export interface Session extends Participant { room?: Room; hello: boolean; }

let clientCounter = 0;

/** Transport-agnostic lobby: feed it ClientMsgs, it routes to rooms. */
export class Lobby {
  readonly rooms = new Map<string, Room>();
  constructor(
    private createDuel: CreateDuel,
    private roomOpts: RoomOptions = {},
    private aiDeck?: () => Deck | undefined,
    private getEngine?: () => EngineApi | null,
    private getDbReady?: () => Promise<CardDb | null>,
  ) {}

  connect(send: (m: ServerMsg) => void): Session {
    const s: Session = { id: `c${++clientCounter}`, name: `player${clientCounter}`, kind: "human", send, hello: false };
    send({ type: "welcome", clientId: s.id });
    return s;
  }

  disconnect(s: Session) {
    s.room?.leave(s);
    this.gc();
  }

  private async validateDeckAsync(deck: Deck, format: FormatId): Promise<{ ok: boolean; errors: string[] }> {
    const engine = this.getEngine?.();
    if (engine) {
      // Engine is loaded: must wait for database and enforce validation
      try {
        const db = await Promise.race([
          this.getDbReady?.() ?? Promise.resolve(null),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error("database load timeout")), 10000)),
        ]);
        if (!db) {
          return { ok: false, errors: ["card database loading, please retry"] };
        }
        return await engine.validateDeck(deck, format, db);
      } catch (e) {
        console.warn(`[lobby] engine validateDeck failed for format ${format}:`, e);
        // Never fall back to local check when engine is loaded - report error
        return { ok: false, errors: [`validation error: ${(e as Error).message}`] };
      }
    }
    // Engine not loaded: use local validation (format-agnostic)
    return validateDeck(deck);
  }

  async handle(s: Session, raw: unknown) {
    const msg = raw as ClientMsg;
    const err = (message: string) => s.send({ type: "error", message });
    if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") return err("malformed message");
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
        if (!validation.ok) return err(`invalid deck: ${validation.errors.join("; ")}`);

        // Create room only after validation passes
        const room = new Room(this.createDuel, this.roomOpts, undefined, format, match);
        this.rooms.set(room.id, room);

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
          } else {
            // Agent seat is reserved but not yet connected
            // We'll need to track this in the room for agent connections
            const agent = {
              id: `agent-${room.id}-0`,
              name: `Agent (${opponent.kind})`,
              kind: "agent" as const,
              send: () => {},
            };
            room.join(agent, opponentDeck);
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
          } else {
            // Agent seat is reserved but not yet connected
            const agent = {
              id: `agent-${room.id}-1`,
              name: `Agent (${opponent.kind})`,
              kind: "agent" as const,
              send: () => {},
            };
            room.join(agent, this.aiDeck?.() ?? msg.deck);
            // If launch is requested, the server will launch it via POST /api/agents/launch
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

        // Check if room is full or not waiting
        if (room.isFull) return err("room is full");
        if (room.status !== "waiting") return err("room is not waiting");

        // Validate deck BEFORE joining (enforced validation)
        const validation = await this.validateDeckAsync(msg.deck, room.format);
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
        open: r.status === "waiting" && !r.isFull,
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
      const humans = [...r.players, ...r.spectators].filter((p) => p.kind !== "bot");
      if (r.status === "waiting" && r.players.length === 0) this.rooms.delete(id);
      if (r.status === "done" && humans.length === 0) this.rooms.delete(id);
    }
  }
}
