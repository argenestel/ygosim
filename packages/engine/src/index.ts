import { randomBytes } from "node:crypto";
import type { Action, Duel, DuelOptions as ProtocolDuelOptions, PlayerIdx, Prompt, StepResult } from "@ygosim/protocol";
import createCore, { OcgDuelMode, OcgLogType, OcgLocation, OcgMessageType, OcgPosition, OcgProcessResult, type OcgCoreSync, type OcgDuelHandle } from "ocgcore-wasm";
import { loadCardDb, toOcgCard, type SqlCardDb } from "./carddb.js";
import { loadStrings, makeScriptReader } from "./data.js";
import { translatePrompt } from "./prompts.js";
import { DuelTracker } from "./state.js";
import { adaptResponse } from "./response.js";

export { loadCardDb } from "./carddb.js";
export { parseYdk } from "./ydk.js";
export type { Action, CardData, CardDb, CardRef, Deck, Duel, DuelEvent, DuelState, PlayerIdx, Prompt, StepResult } from "@ygosim/protocol";
export interface DuelOptions extends ProtocolDuelOptions {
  /** Defaults to player 0. Core teams are mapped to preserve protocol player IDs. */
  firstPlayer?: PlayerIdx;
  /** Ask player 0 to choose who starts before creating the core duel. */
  chooseFirstTurn?: boolean;
}

let sharedCore: Promise<OcgCoreSync> | undefined;
function coreModule() {
  return sharedCore ??= createCore({ sync: true }).catch(error => { sharedCore = undefined; throw error; });
}
function seeds(seed?: number): [bigint, bigint, bigint, bigint] {
  if (seed === undefined) { const b = randomBytes(32); return [0, 8, 16, 24].map(i => b.readBigUInt64LE(i)) as [bigint, bigint, bigint, bigint]; }
  let x = BigInt(seed); const mask = (1n << 64n) - 1n;
  return [0, 1, 2, 3].map(() => {
    x = (x + 0x9e3779b97f4a7c15n) & mask;
    let z = x; z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask; z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask;
    return z ^ (z >> 31n);
  }) as [bigint, bigint, bigint, bigint];
}
function validate(opts: DuelOptions, db: SqlCardDb) {
  if (opts.seed !== undefined && !Number.isSafeInteger(opts.seed)) throw new Error("seed must be a safe integer");
  if (opts.firstPlayer !== undefined && opts.firstPlayer !== 0 && opts.firstPlayer !== 1) throw new Error("firstPlayer must be 0 or 1");
  if (!Number.isInteger(opts.startingLp ?? 8000) || (opts.startingLp ?? 8000) <= 0 || (opts.startingLp ?? 8000) > 0xffffffff) throw new Error("startingLp must be a positive uint32");
  if (!Number.isInteger(opts.masterRule ?? 5) || (opts.masterRule ?? 5) < 1 || (opts.masterRule ?? 5) > 5) throw new Error("masterRule must be between 1 and 5");
  if (!Array.isArray(opts.decks) || opts.decks.length !== 2) throw new Error("Exactly two decks are required");
  for (const deck of opts.decks) {
    if (deck.main.length < 40 || deck.main.length > 60 || deck.extra.length > 15 || deck.side.length > 15) throw new Error("Deck sizes must be main 40–60, extra/side 0–15");
    const copies = new Map<number, number>();
    for (const [zone, codes] of Object.entries(deck)) for (const code of codes as number[]) {
      const c = db.raw.get(code); if (!c) throw new Error(`Unknown card passcode ${code}`);
      if (c.type & 0x4000) throw new Error(`Tokens cannot be included in a deck: ${db.name(code)}`);
      const extra = !!(c.type & (0x40 | 0x2000 | 0x800000 | 0x4000000));
      if (zone === "main" && extra || zone === "extra" && !extra) throw new Error(`Invalid ${zone} deck card: ${db.name(code)}`);
      const identity = c.alias || code; copies.set(identity, (copies.get(identity) ?? 0) + 1);
      if (copies.get(identity)! > 3) throw new Error(`More than three copies of ${db.name(code)}`);
    }
  }
}

class WasmDuel implements Duel {
  private handle?: OcgDuelHandle;
  private tracker: DuelTracker;
  private pending?: ReturnType<typeof translatePrompt>;
  private firstPrompt?: Prompt;
  private first: PlayerIdx;
  private promptSerial = 0;
  private destroyed = false;
  private failures: string[] = [];
  constructor(private core: OcgCoreSync, private db: SqlCardDb, private opts: DuelOptions) {
    this.first = opts.firstPlayer ?? 0;
    this.tracker = new DuelTracker(db, loadStrings(), opts.startingLp ?? 8000, this.first);
    if (opts.chooseFirstTurn) this.firstPrompt = { promptId: `${this.tracker.duelId}:first`, kind: "first_turn", text: "Choose who takes the first turn", min: 1, max: 1, options: [{ id: "0", label: "Player 0 goes first" }, { id: "1", label: "Player 1 goes first" }] };
    else this.initialize();
  }
  private initialize() {
    const readScript = makeScriptReader();
    const masterRule = this.opts.masterRule ?? 5;
    const flags = [OcgDuelMode.MODE_MR1, OcgDuelMode.MODE_MR2, OcgDuelMode.MODE_MR3, OcgDuelMode.MODE_MR4, OcgDuelMode.MODE_MR5][masterRule - 1];
    const team = { startingLP: this.opts.startingLp ?? 8000, startingDrawCount: 5, drawCountPerTurn: 1 };
    const h = this.core.createDuel({ flags, seed: seeds(this.opts.seed), team1: team, team2: team,
      cardReader: code => { const c = this.db.raw.get(code); if (!c) { this.failures.push(`Missing card data: ${code}`); return null; } return toOcgCard(c); },
      scriptReader: readScript,
      errorHandler: (type, message) => { if (type === OcgLogType.ERROR) this.failures.push(message); },
    });
    if (!h) throw new Error("ocgcore could not create a duel");
    this.handle = h;
    try {
      for (const name of ["constant.lua", "utility.lua"]) {
        const script = readScript(name); if (!script || !this.core.loadScript(h, name, script)) throw new Error(`Unable to load core script ${name}`);
      }
      for (const player of [0, 1] as const) {
        const team = (player ^ this.first) as PlayerIdx;
        const deck = this.opts.decks[player];
        for (const [location, cards] of [[OcgLocation.DECK, deck.main], [OcgLocation.EXTRA, deck.extra]] as const) for (const code of cards) {
          this.core.duelNewCard(h, { team, duelist: 0, controller: team, code, location, sequence: 0, position: OcgPosition.FACEDOWN_DEFENSE });
        }
      }
      this.tracker.refresh(this.core, h);
      this.core.startDuel(h); this.checkErrors();
    } catch (error) { this.core.destroyDuel(h); this.handle = undefined; throw error; }
  }
  private ending() { return this.tracker.ended; }
  private live() { if (this.destroyed) throw new Error("Duel has been destroyed"); }
  private checkErrors() { if (this.failures.length) throw new Error(`ocgcore error: ${this.failures.splice(0).join("; ")}`); }
  async step(): Promise<StepResult> {
    this.live();
    if (this.firstPrompt) return { events: [], pending: { player: 0, prompt: structuredClone(this.firstPrompt) } };
    if (this.pending) return { events: [], pending: { player: this.tracker.player(this.pending.player), prompt: structuredClone(this.pending.prompt) } };
    if (this.tracker.ended) return { events: [], ended: { ...this.tracker.ended } };
    const events: StepResult["events"] = [];
    const handle = this.handle!;
    for (let i = 0; i < 10000; i++) {
      const status = this.core.duelProcess(handle);
      this.checkErrors();
      for (const message of this.core.duelGetMessage(handle)) {
        if (message.type === OcgMessageType.RETRY) throw new Error("ocgcore rejected the validated response");
        events.push(...this.tracker.ingest(message));
        const pending = translatePrompt(message, { db: this.db, strings: loadStrings(), card: loc => this.tracker.promptCard(loc, "player" in message ? message.player : 0), promptId: `${this.tracker.duelId}:${++this.promptSerial}` });
        if (pending) { if (this.pending) throw new Error("Multiple simultaneous core prompts"); this.pending = pending; }
      }
      if (status === OcgProcessResult.CONTINUE && !this.tracker.ended) continue;
      this.tracker.refresh(this.core, handle);
      const ended = this.ending();
      if (ended) return { events, ended: { ...ended } };
      if (status === OcgProcessResult.END) throw new Error("Core ended without a victory message");
      if (!this.pending) throw new Error("Core is waiting without a supported prompt");
      return { events, pending: { player: this.tracker.player(this.pending.player), prompt: structuredClone(this.pending.prompt) } };
    }
    throw new Error("Core exceeded 10000 processing iterations without a decision");
  }
  respond(player: PlayerIdx, action: Action): void {
    this.live();
    if (this.firstPrompt) {
      if (player !== 0 || action.promptId !== this.firstPrompt.promptId || action.choose.length !== 1 || !["0", "1"].includes(action.choose[0])) throw new Error("Invalid first-turn response");
      this.first = Number(action.choose[0]) as PlayerIdx;
      this.tracker = new DuelTracker(this.db, loadStrings(), this.opts.startingLp ?? 8000, this.first, this.tracker.duelId);
      this.initialize(); this.firstPrompt = undefined; return;
    }
    if (!this.pending || player !== this.tracker.player(this.pending.player) || action.promptId !== this.pending.prompt.promptId) throw new Error("Wrong player or stale promptId");
    const response = this.pending.respond(action.choose);
    this.core.duelSetResponse(this.handle!, adaptResponse(response)); this.pending = undefined;
  }
  stateFor(viewer: PlayerIdx) { this.live(); if (viewer !== 0 && viewer !== 1) throw new Error("Invalid viewer"); return this.tracker.stateFor(viewer); }
  redactEvents(events: StepResult["events"], viewer: PlayerIdx) { this.live(); if (viewer !== 0 && viewer !== 1) throw new Error("Invalid viewer"); return this.tracker.redactEvents(events, viewer); }
  destroy() { if (this.handle) this.core.destroyDuel(this.handle); this.handle = undefined; this.pending = undefined; this.destroyed = true; }
}

/** Create a duel using the local database/scripts and the synchronous WASM core. */
export async function createDuel(opts: DuelOptions): Promise<Duel> {
  const db = await loadCardDb(); validate(opts, db);
  return new WasmDuel(await coreModule(), db, structuredClone(opts));
}
