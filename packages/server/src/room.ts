import type { Action, Deck, Duel, DuelOptions, FormatId, MatchType, PlayerIdx, Prompt, ServerMsg } from "@ygosim/protocol";
import { defaultAction, isLegal, legalize, type Bot } from "./ai/index.js";
import { spectatorEvents, spectatorState } from "./spectator.js";
import { BotProgress, actionDiagnostic, diagnosticFingerprint } from "./ai/progress.js";
import { generateLegalSelections } from "@ygosim/protocol";
import { performance } from "node:perf_hooks";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

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
  botRepeatLimit?: number;
  botDecisionLimit?: number;
}

interface PendingWait {
  player: PlayerIdx;
  prompt: Prompt;
  resolve: (a: Action) => void;
  reject: (error: unknown) => void;
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
  private adjudicated?: { winner: PlayerIdx | null; reason: string };
  private tournamentControl?: Buffer;
  failure?: string;
  private closed = false;
  private cancelBot?: () => void;
  private siding?: Map<PlayerIdx, () => void>;
  readonly opts: Required<Omit<RoomOptions, "seed">> & { seed?: number };
  /** Resolves when the duel loop finishes. */
  finished?: Promise<void>;
  readonly diagnostics: { decks: string[]; trace: ReturnType<typeof actionDiagnostic>[]; rejectedActions: number; failure?: string } = { decks: [], trace: [], rejectedActions: 0 };
  private diagnosticContext?: { decks: (Deck | undefined)[]; states: import("@ygosim/protocol").DuelState[]; prompt: Prompt; failure?: string; trace: { player: PlayerIdx; prompt: Prompt; action: Action; rejected: boolean; error?: string }[] };

  constructor(
    private createDuel: CreateDuel,
    opts: RoomOptions = {},
    id?: string,
    format: FormatId = "tcg",
    match: MatchType = "single",
    tournament?: { controlToken: string }
  ) {
    this.id = id ?? `r${++roomCounter}${Math.random().toString(36).slice(2, 6)}`;
    this.format = format;
    this.match = match;
    if (tournament) this.tournamentControl = createHash("sha256").update(tournament.controlToken).digest();
    this.opts = { turnTimeoutMs: 180_000, botDelayMs: 0, maxInvalid: 5, botRepeatLimit: 12, botDecisionLimit: 512, ...opts, seed: opts.seed ?? randomInt(2 ** 48 - 1) };
  }

  get players(): Participant[] { return this.seats.filter((s): s is Participant => !!s); }
  getDiagnosticContext() {
    return this.diagnosticContext ? structuredClone({ roomId: this.id, seed: this.opts.seed, format: this.format, game: this.game, ...this.diagnosticContext }) : undefined;
  }
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

  /** Stop pending decisions/siding and let the duel loop release its engine. */
  async close(): Promise<void> {
    this.closed = true;
    this.status = "done";
    if (this.wait) this.wait.resolve({ promptId: this.wait.prompt.promptId, choose: [] });
    this.cancelBot?.();
    for (const confirm of this.siding?.values() ?? []) confirm();
    await this.finished;
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
    if (this.failure) msg.failure = this.failure;
    return msg;
  }
  broadcastRoom() { this.broadcast(this.roomMsg()); }
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
      if (w.invalid >= this.opts.maxInvalid) {
        if (this.tournamentControl) {
          this.forfeit(seat, "invalid-actions");
          return;
        }
        try { w.resolve(defaultAction(w.prompt)); } catch (error) { w.reject(error); }
      }
      return;
    }
    w.resolve(action);
  }

  submitSideDeck(p: Participant, deck: Deck) {
    const seat = this.seatOf(p);
    if (seat === undefined) return safeSend(p, { type: "error", message: "not a player" });
    if (this.status !== "siding") return safeSend(p, { type: "error", message: "not in siding" });
    if (!this.siding?.has(seat)) return;
    const original = this.originalDecks[seat]!;
    const before = [...original.main, ...original.extra, ...original.side].sort((a, b) => a - b);
    const after = [...deck.main, ...deck.extra, ...deck.side].sort((a, b) => a - b);
    if (["main", "extra", "side"].some(zone => deck[zone as keyof Deck].length !== original[zone as keyof Deck].length)
      || before.length !== after.length || before.some((code, index) => code !== after[index])) {
      return safeSend(p, { type: "error", message: "side-decking must preserve the registered cards and each deck section's size" });
    }
    this.decks[seat] = structuredClone(deck);
    this.siding.get(seat)!();
  }

  surrender(p: Participant) {
    const seat = this.seatOf(p);
    if (seat === undefined || this.status !== "dueling") return;
    this.surrendered = seat;
    this.cancelBot?.();
    // Unblock a waiting decision so the loop notices.
    if (this.wait) this.wait.resolve({ promptId: this.wait.prompt.promptId, choose: [] });
  }

  adjudicate(controlToken: string, winner: PlayerIdx | null, reason: "timeout" | "agent-crash"): boolean {
    if (!this.tournamentControl || this.status !== "dueling" || this.adjudicated) return false;
    const candidate = createHash("sha256").update(controlToken).digest();
    if (!timingSafeEqual(candidate, this.tournamentControl)) return false;
    this.adjudicated = { winner, reason };
    if (this.wait) this.wait.resolve({ promptId: this.wait.prompt.promptId, choose: [] });
    return true;
  }

  private forfeit(player: PlayerIdx, reason: string): void {
    this.adjudicated = { winner: (1 - player) as PlayerIdx, reason };
    if (this.wait) this.wait.resolve({ promptId: this.wait.prompt.promptId, choose: [] });
  }

  private async run() {
    let firstPlayer: PlayerIdx = 0;
    try {
      for (;;) {
        if (this.closed) return;
        await this.runGame(firstPlayer);
        if (this.isGameDone()) return;
        // Save a snapshot before destroying the old duel for the match prompt.
        const previousWinner = this.winner;
        const chooser = previousWinner == null ? undefined : (1 - previousWinner) as PlayerIdx;
        const state = chooser === undefined ? undefined : this.duel!.stateFor(chooser);
        this.duel?.destroy();
        this.duel = undefined;
        await this.sideDecks();
        if (this.closed) return;
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
      if (this.diagnosticContext) this.diagnosticContext.failure = String(e);
      const message = e instanceof Error ? e.message : "";
      this.diagnostics.failure = message.startsWith("bot made no progress") ? "bot made no progress; start a new duel and report the room reference"
        : message.startsWith("no acceptable action") ? "no acceptable action within selection search budget"
        : message === "bot decision timed out" ? message : "unexpected duel failure";
      this.failure = this.diagnostics.failure;
      console.error(`[room ${this.id}]`, this.diagnostics);
      this.broadcast({ type: "error", message: `duel aborted: ${this.diagnostics.failure}; room ${this.id}` });
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
    this.diagnostics.decks = this.decks.map(diagnosticFingerprint);
    const actionTrace: NonNullable<Room["diagnosticContext"]>["trace"] = [];
    const diagnosticDecks = structuredClone(this.decks);
    const progress = new BotProgress(this.opts.botRepeatLimit, this.opts.botDecisionLimit);
    let yieldedAt = performance.now();
    for (let steps = 0; ; steps++) {
      // Synchronous engines and bots otherwise keep the microtask queue busy,
      // preventing socket messages, deadlines and shutdown from being handled.
      if (steps % 100 === 99 || performance.now() - yieldedAt >= 8) {
        await new Promise<void>(resolve => setImmediate(resolve));
        yieldedAt = performance.now();
      }
      if (this.closed) return;
      if (this.adjudicated) {
        this.finish(this.adjudicated.winner, this.adjudicated.reason);
        break;
      }
      if (this.surrendered !== undefined) {
        this.finish((1 - this.surrendered) as PlayerIdx, "surrender");
        break;
      }

      const res = await this.duel.step();
      if (this.closed) return;
      this.sendEvents(res.events);
      if (res.ended || !res.pending) {
        const gameWinner = res.ended?.winner ?? null;
        this.finish(gameWinner, res.ended?.reason ?? "ended", !!res.events.some((e) => e.t === "win"));
        break;
      }
      const { player, prompt } = res.pending;
      const states = [this.duel.stateFor(0), this.duel.stateFor(1)];
      this.diagnosticContext = { decks: diagnosticDecks, states, prompt: structuredClone(prompt), trace: actionTrace };
      if (this.seats[player]!.bot) progress.observe(states, player, prompt, res.events);
      await this.resolvePrompt(player, prompt, states[player]!);
    }
  }

  private async resolvePrompt(player: PlayerIdx, prompt: Prompt, state: import("@ygosim/protocol").DuelState) {
    const duel = this.duel!;
    const seat = this.seats[player]!;
    for (let attempt = 0; ; attempt++) {
      let action: Action;
      if (seat.bot) {
        let cand: Action | undefined;
        let timer: NodeJS.Timeout | undefined;
        let delayTimer: NodeJS.Timeout | undefined;
        try {
          cand = await Promise.race([
            Promise.resolve().then(async () => {
              if (this.closed || this.surrendered !== undefined) return undefined;
              if (this.opts.botDelayMs) await new Promise<void>(resolve => { delayTimer = setTimeout(resolve, this.opts.botDelayMs); });
              if (this.closed || this.surrendered !== undefined) return undefined;
              return seat.bot!.choose(state, prompt);
            }),
            new Promise<Action | undefined>((resolve, reject) => {
              this.cancelBot = () => resolve(undefined);
              timer = setTimeout(() => reject(new Error("bot decision timed out")), this.opts.turnTimeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
          clearTimeout(delayTimer);
          this.cancelBot = undefined;
        }
        if (this.closed || this.surrendered !== undefined) return;
        if (cand && !isLegal(prompt, cand)) {
          this.diagnostics.rejectedActions++;
          this.diagnosticContext?.trace.push({ player, prompt: structuredClone(prompt), action: structuredClone(cand), rejected: true, error: "bot returned an invalid selection" });
          if (this.diagnosticContext && this.diagnosticContext.trace.length > 32) this.diagnosticContext.trace.shift();
          this.diagnostics.trace.push(actionDiagnostic(player, prompt, cand, true));
          if (this.diagnostics.trace.length > 32) this.diagnostics.trace.shift();
          safeSend(seat, { type: "error", message: "bot returned an invalid selection; using a legal fallback" });
        }
        action = legalize(prompt, cand);
      } else {
        const answer = this.waitFor(player, prompt);
        safeSend(seat, { type: "prompt", prompt, state });
        action = await answer;
      }
      if (this.closed || this.surrendered !== undefined || this.adjudicated) return;
      const record = { player, prompt: structuredClone(prompt), action: structuredClone(action), rejected: false, error: undefined as string | undefined };
      this.diagnosticContext?.trace.push(record);
      if (this.diagnosticContext && this.diagnosticContext.trace.length > 32) this.diagnosticContext.trace.shift();
      try {
        duel.respond(player, action);
        this.diagnostics.trace.push(actionDiagnostic(player, prompt, action));
        if (this.diagnostics.trace.length > 32) this.diagnostics.trace.shift();
        return;
      } catch (e) {
        this.diagnostics.rejectedActions++;
        record.rejected = true;
        record.error = String(e);
        this.diagnostics.trace.push(actionDiagnostic(player, prompt, action, true));
        if (this.diagnostics.trace.length > 32) this.diagnostics.trace.shift();
        // Engine rejected a structurally valid answer; tell humans and re-ask, fall back eventually.
        safeSend(seat, { type: "error", message: "engine rejected action; choose a valid response to the current prompt" });
        if (attempt >= 2) {
          if (this.tournamentControl) throw new Error(`no acceptable action for prompt ${prompt.promptId}`);
          for (const choose of generateLegalSelections(prompt).candidates) {
            const opt = { promptId: prompt.promptId, choose };
            const fallback = { player, prompt: structuredClone(prompt), action: opt, rejected: false, error: undefined as string | undefined };
            this.diagnosticContext?.trace.push(fallback);
            if (this.diagnosticContext && this.diagnosticContext.trace.length > 32) this.diagnosticContext.trace.shift();
            try {
              duel.respond(player, opt);
              this.diagnostics.trace.push(actionDiagnostic(player, prompt, opt));
              if (this.diagnostics.trace.length > 32) this.diagnostics.trace.shift();
              return;
            } catch (e) {
              this.diagnostics.rejectedActions++;
              fallback.rejected = true;
              fallback.error = String(e);
              this.diagnostics.trace.push(actionDiagnostic(player, prompt, opt, true));
              if (this.diagnostics.trace.length > 32) this.diagnostics.trace.shift();
            }
          }
          throw new Error(`no acceptable action for prompt ${prompt.promptId}`);
        }
      }
    }
  }

  private waitFor(player: PlayerIdx, prompt: Prompt): Promise<Action> {
    return new Promise<Action>((resolve, reject) => {
      const done = (a: Action) => {
        if (this.wait?.prompt !== prompt) return;
        clearTimeout(this.wait.timer);
        this.wait = undefined;
        resolve(a);
      };
      const timer = setTimeout(() => {
        const seat = this.seats[player];
        if (this.tournamentControl) {
          if (seat) safeSend(seat, { type: "error", message: "turn timer expired; tournament forfeit" });
          this.forfeit(player, "decision-timeout");
          return;
        }
        if (seat) safeSend(seat, { type: "error", message: "turn timer expired; auto-picked a default action" });
        try { done(defaultAction(prompt)); } catch (error) { failed(error); }
      }, this.opts.turnTimeoutMs);
      const failed = (error: unknown) => {
        if (this.wait?.prompt !== prompt) return;
        clearTimeout(this.wait.timer);
        this.wait = undefined;
        reject(error);
      };
      this.wait = { player, prompt, resolve: done, reject: failed, timer, invalid: 0 };
    });
  }

  private sendEvents(events: import("@ygosim/protocol").DuelEvent[]) {
    const duel = this.duel!;
    for (const idx of [0, 1] as const) {
      const p = this.seats[idx];
      if (p && !p.bot) safeSend(p, { type: "events", events: duel.redactEvents(events, idx), state: duel.stateFor(idx) });
    }
    if (this.spectators.size) {
      const msg: ServerMsg = { type: "events", events: spectatorEvents(duel, events), state: spectatorState(duel) };
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
      for (const s of this.spectators) safeSend(s, { type: "events", events: ev, state: spectatorState(this.duel) });
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
