import { z } from "zod";
import { CardCache } from "./cards.js";
import { GameClient, type WaitResult } from "./client.js";
import { fetchSampleDecks, resolveDeck } from "./deck.js";
import { collectCodes, renderEvents, renderPrompt, renderState } from "./render.js";

export interface Config { baseUrl: string; name: string }

export function configFromEnv(env = process.env): Config {
  const baseUrl = (env.YGOSIM_URL ?? "ws://localhost:7777").replace(/\/+$/, "");
  return { baseUrl, name: env.YGOSIM_NAME ?? "agent" };
}

export function wsUrlFor(base: string): string {
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol;
  if (u.pathname === "/" || u.pathname === "") u.pathname = "/ws";
  return u.toString();
}
const httpFor = (base: string) => {
  const u = new URL(base);
  u.protocol = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
  u.pathname = u.pathname.replace(/\/ws\/?$/, "");
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/+$/, "");
};

const deckShape = {
  deck: z.string().optional().describe("Sample deck name from the server (see list_rooms output), e.g. 'Starter'. Default: first sample deck."),
  ydk: z.string().optional().describe("Full .ydk deck file text (#main/#extra/!side)."),
  main: z.array(z.number().int().positive()).optional().describe("Main deck passcodes"),
  extra: z.array(z.number().int().positive()).optional().describe("Extra deck passcodes"),
  side: z.array(z.number().int().positive()).optional(),
};

export interface ToolDef { name: string; description: string; shape: z.ZodRawShape; run(args: any): Promise<string> }

/** Session = one connection + the shared tool implementations (used by both MCP and the JSON-lines CLI). */
export class Session {
  http: string;
  cards: CardCache;
  client: GameClient;

  constructor(public cfg: Config) {
    this.http = httpFor(cfg.baseUrl);
    this.cards = new CardCache(this.http);
    this.client = new GameClient(wsUrlFor(cfg.baseUrl), cfg.name);
  }

  private async deckFrom(a: any) {
    return resolveDeck({ sample: a.deck, ydk: a.ydk, main: a.main, extra: a.extra, side: a.side }, this.http);
  }

  /** Board + unread events + chat + prompt, as compact text. */
  async report(w?: WaitResult): Promise<string> {
    const c = this.client;
    const state = c.state, prompt = c.prompt, ended = c.ended;
    const events = c.drainEvents();
    const chat = c.drainChat();
    await this.cards.prefetch(collectCodes(state, events, prompt));
    const out: string[] = [];
    if (w?.kind === "error") out.push(`ERROR from server: ${w.message}`);
    if (!w) {
      const errors = c.unreadErrors.splice(0);
      if (errors.length) out.push(`ERROR from server: ${errors.join("; ")}`);
    }
    if (state) {
      const ev = renderEvents(events, state.you, this.cards);
      if (ev) out.push("## Events since last check", ev);
      out.push("## Board", renderState(state, this.cards));
    }
    if (chat.length) out.push("## Chat", ...chat.map((m) => `${m.from}: ${m.text}`));
    if (ended) {
      const you = state?.you;
      out.push(`## DUEL OVER: ${ended.winner === null ? "draw" : ended.winner === you ? "you WON" : "you LOST"} (${ended.reason})`);
    } else if (prompt) {
      out.push("## Your decision", renderPrompt(prompt, this.cards), `Respond with act(choose=[option numbers or string ids]). Use card_info for effect text.`);
    } else if (w?.kind === "timeout") {
      out.push(c.room?.status === "waiting" ? "Still waiting for an opponent to join. Call wait_for_turn again." : "No decision needed yet (opponent acting). Call wait_for_turn again.");
    }
    return out.join("\n") || `No duel state yet${c.room ? ` (room ${c.room.roomId} ${c.room.status})` : ""}.`;
  }

  tools(): ToolDef[] {
    const c = this.client;
    return [
      {
        name: "list_rooms",
        description: "List open rooms on the ygosim server and available sample decks.",
        shape: {},
        run: async () => {
          const r = await fetch(`${this.http}/api/rooms`, { signal: AbortSignal.timeout(5000) });
          if (!r.ok) throw new Error(`GET /api/rooms failed: HTTP ${r.status}`);
          const rooms = (await r.json()) as any;
          const list: any[] = Array.isArray(rooms) ? rooms : rooms.rooms ?? [];
          const decks = await fetchSampleDecks(this.http);
          const lines = list.length
            ? list.map((x) => `- ${x.roomId ?? x.id}: ${x.status ?? "?"} players=[${(x.players ?? []).map((p: string | { name: string; kind: string }) => typeof p === "string" ? p : `${p.name} (${p.kind})`).join(", ")}]${x.vsAI ? " (vs AI)" : ""}`)
            : ["(no rooms)"];
          return ["Rooms:", ...lines, `Sample decks: ${decks.map((d) => d.name).join(", ") || "(none)"}`].join("\n");
        },
      },
      {
        name: "create_room",
        description: "Create a duel room. Set vsAI=true to duel the built-in AI immediately. Deck: sample name, ydk text, or passcode lists. Then call wait_for_turn.",
        shape: { vsAI: z.boolean().default(true), level: z.enum(["easy", "normal", "hard"]).default("normal").describe("AI difficulty"), ...deckShape },
        run: async (a) => {
          const room = await c.createRoom(await this.deckFrom(a), a.vsAI ?? true, a.level ?? "normal");
          return `Room ${room.roomId} created (status ${room.status}, players ${room.players.join(", ")}). Now call wait_for_turn.`;
        },
      },
      {
        name: "join_room",
        description: "Join an existing room by id with a deck. Then call wait_for_turn.",
        shape: { roomId: z.string(), ...deckShape },
        run: async (a) => {
          const room = await c.joinRoom(a.roomId, await this.deckFrom(a));
          return `Joined room ${room.roomId} (status ${room.status}, players ${room.players.join(", ")}). Now call wait_for_turn.`;
        },
      },
      {
        name: "wait_for_turn",
        description: "Block until you must make a decision or the duel ends (long-poll). Returns new events, the board, and the prompt with numbered options. On timeout just call again.",
        shape: { timeoutSec: z.number().min(1).max(600).default(60).describe("Max seconds to wait") },
        run: async (a) => {
          if (!c.room) return "Not in a room. Call create_room or join_room first.";
          return this.report(await c.waitForTurn((a.timeoutSec ?? 60) * 1000));
        },
      },
      {
        name: "get_state",
        description: "Show the current board and pending prompt (if any) without waiting.",
        shape: {},
        run: async () => this.report(),
      },
      {
        name: "act",
        description: "Answer the pending prompt with 1-based option number(s) or string option id(s), then wait for the next decision (unless wait=false). Returns the same output as wait_for_turn.",
        shape: { choose: z.array(z.union([z.string(), z.number().int().positive()])).describe("1-based displayed option numbers, e.g. [1], or exact string ids, e.g. [\"summon:uid\"]"), promptId: z.string().optional().describe("Optional current promptId to reject stale actions"), wait: z.boolean().default(true), timeoutSec: z.number().min(1).max(600).default(60) },
        run: async (a) => {
          c.act(a.choose, a.promptId);
          if (a.wait === false) return "Action sent.";
          return this.report(await c.waitForTurn((a.timeoutSec ?? 60) * 1000));
        },
      },
      {
        name: "card_info",
        description: "Look up a card's full text and stats by passcode or (partial) name.",
        shape: { code: z.number().int().positive().optional(), name: z.string().min(1).optional() },
        run: async (a) => {
          if (a.code === undefined && !a.name) throw new Error("provide a card code or name");
          const list = a.code !== undefined ? [await this.cards.get(a.code)].filter((x) => !!x) : a.name ? (await this.cards.search(a.name)).slice(0, 5) : [];
          if (!list.length) return "No card found.";
          return list.map((d: any) => {
            const st = [d.attribute, d.race, d.level !== undefined ? `Level/Rank ${d.level}` : "", d.atk !== undefined ? `ATK ${d.atk}${d.def !== undefined ? ` / DEF ${d.def}` : ""}` : "", d.linkMarkers?.length ? `Link arrows ${d.linkMarkers.join(",")}` : "", d.scale !== undefined ? `Scale ${d.scale}` : ""].filter(Boolean).join(" | ");
            return `${d.name} (#${d.code}) [${d.type.join("/")}]${st ? `\n${st}` : ""}\n${d.desc}`;
          }).join("\n\n");
        },
      },
      {
        name: "chat",
        description: "Send a chat message to the room.",
        shape: { text: z.string().min(1).max(500) },
        run: async (a) => { c.send({ type: "chat", text: a.text }); return "sent"; },
      },
      {
        name: "surrender",
        description: "Concede the current duel.",
        shape: {},
        run: async () => { c.send({ type: "surrender" }); c.prompt = null; return "Surrender sent. Call wait_for_turn for the result."; },
      },
    ];
  }
}
