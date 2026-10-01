import type { Action, Deck, Duel, DuelOptions, FormatId, MatchType, PlayerIdx, Prompt, ServerMsg } from "@ygosim/protocol";
import { defaultAction, isLegal, legalize, type Bot } from "./ai/index.js";

/** Anything that can sit in a seat: a socket client (send) or a bot. */
export interface Participant {
  id: string;
  name: string;
  kind: "human" | "agent" | "bot";
  send(msg: ServerMsg): void;
  bot?: Bot;
}

export type CreateDuel = (opts: DuelOptions & { format?: FormatId; firstPlayer?: PlayerIdx }) => Promise<Duel>;

export interface RoomOptions {
  turnTimeoutMs?: number;     // per decision; default 180s (LLM-friendly)
  botDelayMs?: number;        // small pause so humans can follow bot moves
  maxInvalid?: number;        // invalid actions before auto-pick
  seed?: number;
}

interface PendingWait {
  player: PlayerIdx;
  prompt: Prompt;
  resolve: (a: Action) => void;
  timer: NodeJS.Timeout;
  invalid: number;
}

let roomCounter = 0;

export class Room {
  readonly id: string;
  readonly seats: (Participant | undefined)[] = [undefined, undefined];
  readonly decks: (Deck | undefined)[] = [undefined, undefined];
  readonly originalDecks: (Deck | undefined)[] = [undefined, undefined];
  readonly spectators = new Set<Participant>();
  status: "waiting" | "dueling" | "siding" | "done" = "waiting";
  format: FormatId = "tcg";
  match: MatchType = "single";
  score: [number, number] = [0, 0];
  game: number = 1;
  winner?: PlayerIdx | null;
  private duel?: Duel;
  private wait?: PendingWait;
  private surrendered?: PlayerIdx;
  private siding?: Map<PlayerIdx, () => void>;
  readonly opts: Required<Omit<RoomOptions, "seed">> & { seed?: number };
  /** Resolves when the duel loop finishes. */
  finished?: Promise<void>;

  constructor(
    private createDuel: CreateDuel,
    opts: RoomOptions = {},
    id?: string,
    format: FormatId = "tcg",
    match: MatchType = "single"
  ) {
    this.id = id ?? `r${++roomCounter}${Math.random().toString(36).slice(2, 6)}`;
    this.format = format;
    this.match = match;
    this.opts = { turnTimeoutMs: 180_000, botDelayMs: 0, maxInvalid: 5, ...opts };
  }

  get players(): Participant[] { return this.seats.filter((s): s is Participant => !!s); }
  get isFull(): boolean { return !!this.seats[0] && !!this.seats[1]; }
  private isGameDone(): boolean { return this.status === "done"; }

  seatOf(p: Participant): PlayerIdx | undefined {
    const i = this.seats.findIndex((s) => s?.id === p.id);
    return i < 0 ? undefined : (i as PlayerIdx);
  }

  /** Seat a participant. Returns seat, or "spectator" if full. */
  join(p: Participant, deck: Deck): PlayerIdx | "spectator" {
    if (this.status !== "waiting" || this.isFull) {
      this.spectators.add(p);
      this.broadcastRoom();
      return "spectator";
    }
    const idx = (this.seats[0] ? 1 : 0) as PlayerIdx;
    this.seats[idx] = p;
    this.decks[idx] = structuredClone(deck);
    this.originalDecks[idx] = structuredClone(deck);
    this.broadcastRoom();
    if (this.isFull) this.finished = this.run();
    return idx;
  }

  leave(p: Participant) {
    this.spectators.delete(p);
    const seat = this.seatOf(p);
    if (seat === undefined) return;
    if (this.status === "dueling") this.surrender(p);
    else if (this.status === "waiting") {
      this.seats[seat] = undefined;
      this.decks[seat] = undefined;
      this.originalDecks[seat] = undefined;
    }
  }

  roomMsg(): ServerMsg {
    const msg: ServerMsg = {
      type: "room",
      roomId: this.id,
      players: this.players.map((p) => p.name),
      status: this.status,
      format: this.format,
      match: this.match,
    };
    if (this.match === "match") {
      msg.score = [...this.score];
      msg.game = this.game;
    }
    return msg;
  }
  private broadcastRoom() { this.broadcast(this.roomMsg()); }
  broadcast(msg: ServerMsg) {
    for (const p of [...this.players, ...this.spectators]) safeSend(p, msg);
  }

  chat(from: Participant, text: string) {
    this.broadcast({ type: "chat", from: from.name, text: String(text).slice(0, 500) });
  }

  /** Submit an action from a seated client. Errors are reported to the sender. */
  submit(p: Participant, action: Action) {
    const seat = this.seatOf(p);
    const w = this.wait;
    if (seat === undefined) return safeSend(p, { type: "error", message: "not a player in this room" });
    if (!w || w.player !== seat) return safeSend(p, { type: "error", message: "not your decision" });
    if (!isLegal(w.prompt, action)) {
      w.invalid++;
      safeSend(p, { type: "error", message: `illegal action for prompt ${w.prompt.promptId}; choose ${describeBounds(w.prompt)} of the option ids` });
      if (w.invalid >= this.opts.maxInvalid) w.resolve(defaultAction(w.prompt));
      return;
    }
    w.resolve(action);
  }

  submitSideDeck(p: Participant, deck: Deck) {
    const seat = this.seatOf(p);
    if (seat === undefined) return safeSend(p, { type: "error", message: "not a player" });
    if (this.status !== "siding") return safeSend(p, { type: "error", message: "not in siding" });
    if (!this.siding?.has(seat)) return;
    this.decks[seat] = structuredClone(deck);
    this.siding.get(seat)!();
  }

  surrender(p: Participant) {
    const seat = this.seatOf(p);
    if (seat === undefined || this.status !== "dueling") return;
    this.surrendered = seat;
    // Unblock a waiting decision so the loop notices.
    if (this.wait) this.wait.resolve(defaultAction(this.wait.prompt));
  }

  private async run() {
    let firstPlayer: PlayerIdx = 0;
    try {
      for (;;) {
        await this.runGame(firstPlayer);
        if (this.isGameDone()) return;
        // Save a snapshot before destroying the old duel for the match prompt.
        const previousWinner = this.winner;
        const chooser = previousWinner == null ? undefined : (1 - previousWinner) as PlayerIdx;
        const state = chooser === undefined ? undefined : this.duel!.stateFor(chooser);
        this.duel?.destroy();
        this.duel = undefined;
        await this.sideDecks();
        this.game++;
        this.surrendered = undefined;
        this.status = "dueling";
        this.broadcastRoom();
        if (chooser !== undefined && state) {
          const prompt: Prompt = {
            promptId: `${this.id}:first:${this.game}`, kind: "first_turn",
            text: "Choose who takes the first turn", min: 1, max: 1,
            options: [{ id: "0", label: "Player 0 goes first" }, { id: "1", label: "Player 1 goes first" }],
          };
          const seat = this.seats[chooser]!;
          let action: Action;
          if (seat.bot) action = legalize(prompt, await seat.bot.choose(state, prompt));
          else {
            const answer = this.waitFor(chooser, prompt);
            safeSend(seat, { type: "prompt", prompt, state });
            action = await answer;
          }
          firstPlayer = Number(action.choose[0]) as PlayerIdx;
        }
      }
    } catch (e) {
      console.error(`[room ${this.id}]`, e);
      this.broadcast({ type: "error", message: `duel aborted: ${(e as Error).message}` });
      this.status = "done";
      this.broadcastRoom();
    } finally {
      this.duel?.destroy();
      this.duel = undefined;
    }
  }

  private async sideDecks() {
    this.status = "siding";
    const confirmations = new Map<PlayerIdx, () => void>();
    this.siding = confirmations;
    const waits = ([0, 1] as const).map(player => {
      if (this.seats[player]!.bot) {
        this.decks[player] = structuredClone(this.originalDecks[player]!);
        return Promise.resolve();
      }
      return new Promise<void>(resolve => {
        const done = () => {
          clearTimeout(timer);
          confirmations.delete(player);
          resolve();
        };
        const timer = setTimeout(done, 60_000);
        confirmations.set(player, done);
      });
    });
    this.broadcastRoom();
    await Promise.all(waits);
    this.siding = undefined;
  }

  private async runGame(firstPlayer: PlayerIdx) {
    this.status = "dueling";
    this.broadcastRoom();
    this.duel = await this.createDuel({ decks: [this.decks[0]!, this.decks[1]!], seed: this.opts.seed, format: this.format, firstPlayer });
    for (;;) {
      if (this.surrendered !== undefined) {
        this.finish((1 - this.surrendered) as PlayerIdx, "surrender");
        break;
      }
      const res = await this.duel.step();
      this.sendEvents(res.events);
      if (res.ended || !res.pending) {
        const gameWinner = res.ended?.winner ?? null;
        this.finish(gameWinner, res.ended?.reason ?? "ended", !!res.events.some((e) => e.t === "win"));
        break;
      }
      const { player, prompt } = res.pending;
      await this.resolvePrompt(player, prompt);
    }
  }

  private async resolvePrompt(player: PlayerIdx, prompt: Prompt) {
    const duel = this.duel!;
    const seat = this.seats[player]!;
    for (let attempt = 0; ; attempt++) {
      let action: Action;
      if (seat.bot) {
        if (this.opts.botDelayMs) await sleep(this.opts.botDelayMs);
        let cand: Action | undefined;
        try {
          const chooseResult = seat.bot.choose(duel.stateFor(player), prompt);
          cand = await Promise.resolve(chooseResult);
        } catch { cand = undefined; }
        action = legalize(prompt, cand);
      } else {
        const answer = this.waitFor(player, prompt);
        safeSend(seat, { type: "prompt", prompt, state: duel.stateFor(player) });
        action = await answer;
      }
      if (this.surrendered !== undefined) return;
      try {
        duel.respond(player, action);
        return;
      } catch (e) {
        // Engine rejected a structurally valid answer; tell humans and re-ask, fall back eventually.
        safeSend(seat, { type: "error", message: `engine rejected action: ${(e as Error).message}` });
        if (attempt >= 2) {
          for (const opt of [defaultAction(prompt), ...prompt.options.map((o) => ({ promptId: prompt.promptId, choose: [o.id] }))]) {
            try { duel.respond(player, opt); return; } catch { /* try next */ }
          }
          throw new Error(`no acceptable action for prompt ${prompt.promptId}`);
        }
      }
    }
  }

  private waitFor(player: PlayerIdx, prompt: Prompt): Promise<Action> {
    return new Promise<Action>((resolve) => {
      const done = (a: Action) => {
        if (this.wait?.prompt !== prompt) return;
        clearTimeout(this.wait.timer);
        this.wait = undefined;
        resolve(a);
      };
      const timer = setTimeout(() => {
        const seat = this.seats[player];
        if (seat) safeSend(seat, { type: "error", message: "turn timer expired; auto-picked a default action" });
        done(defaultAction(prompt));
      }, this.opts.turnTimeoutMs);
      this.wait = { player, prompt, resolve: done, timer, invalid: 0 };
    });
  }

  private sendEvents(events: import("@ygosim/protocol").DuelEvent[]) {
    const duel = this.duel!;
    for (const idx of [0, 1] as const) {
      const p = this.seats[idx];
      if (p && !p.bot) safeSend(p, { type: "events", events: duel.redactEvents(events, idx), state: duel.stateFor(idx) });
    }
    if (this.spectators.size) {
      const msg: ServerMsg = { type: "events", events: duel.redactEvents(events, 0), state: duel.stateFor(0) };
      for (const s of this.spectators) safeSend(s, msg);
    }
  }

  private finish(winner: PlayerIdx | null, reason: string, alreadyAnnounced = false) {
    this.winner = winner;
    if (this.match === "match" && winner !== null) this.score[winner]++;
    this.status = this.match !== "match" || this.score.some(score => score >= 2) || this.game >= 3 ? "done" : "dueling";
    if (!alreadyAnnounced && this.duel) {
      const ev = [{ t: "win" as const, winner, reason }];
      for (const idx of [0, 1] as const) {
        const p = this.seats[idx];
        if (p && !p.bot) safeSend(p, { type: "events", events: ev, state: this.duel.stateFor(idx) });
      }
      for (const s of this.spectators) safeSend(s, { type: "events", events: ev, state: this.duel.stateFor(0) });
    }
    if (this.status === "done") this.broadcastRoom();
  }
}

function describeBounds(p: Prompt) {
  const min = p.min ?? 1, max = p.max ?? Math.max(min, 1);
  return min === max ? `exactly ${min}` : `${min}-${max}`;
}
function safeSend(p: Participant, msg: ServerMsg) {
  try { p.send(msg); } catch { /* socket gone */ }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
