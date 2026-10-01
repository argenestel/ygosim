import type { ClientMsg, Deck, FormatId, MatchType, ServerMsg } from "@ygosim/protocol";
import { createBot } from "./ai/index.js";
import { Room, type CreateDuel, type Participant, type RoomOptions } from "./room.js";
import { validateDeck } from "./decks.js";

export interface Session extends Participant { room?: Room; hello: boolean; }

let clientCounter = 0;

/** Transport-agnostic lobby: feed it ClientMsgs, it routes to rooms. */
export class Lobby {
  readonly rooms = new Map<string, Room>();
  constructor(private createDuel: CreateDuel, private roomOpts: RoomOptions = {}, private aiDeck?: () => Deck | undefined) {}

  connect(send: (m: ServerMsg) => void): Session {
    const s: Session = { id: `c${++clientCounter}`, name: `player${clientCounter}`, kind: "human", send, hello: false };
    send({ type: "welcome", clientId: s.id });
    return s;
  }

  disconnect(s: Session) {
    s.room?.leave(s);
    this.gc();
  }

  handle(s: Session, raw: unknown) {
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
        const v = validateDeck(msg.deck);
        if (!v.ok) return err(`invalid deck: ${v.errors.join("; ")}`);
        const format = msg.format ?? "tcg";
        const match = msg.match ?? "single";
        const room = new Room(this.createDuel, this.roomOpts, undefined, format, match);
        this.rooms.set(room.id, room);
        s.room = room;
        room.join(s, msg.deck);
        if (msg.vsAI) {
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
        const v = validateDeck(msg.deck);
        if (!v.ok && !(room.isFull || room.status !== "waiting")) return err(`invalid deck: ${v.errors.join("; ")}`);
        s.room = room;
        room.join(s, msg.deck);
        return;
      }
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
