import type { Duel, DuelEvent, PlayerIdx, Prompt, PromptOption, StepResult } from '@ygosim/protocol';
import { OcgDuelMode, OcgLocation as L, OcgLogType, OcgPosition as P, OcgProcessResult, OcgMessageType } from 'ocgcore-wasm';
import { createCompatibleCore } from '../../src/core.js';
import { loadCardDb, toOcgCard } from '../../src/carddb.js';
import { loadStrings, makeScriptReader } from '../../src/data.js';
import { DuelTracker } from '../../src/state.js';
import { translatePrompt } from '../../src/prompts.js';
import { adaptResponse } from '../../src/response.js';
import { respondRandomly, rng } from '../../scripts/fuzz-support.js';

export { L, P };
export interface SetupCard { code: number; player: PlayerIdx; location: number; sequence?: number; position?: number }
/** Controlled opening, real DB/scripts/core and production prompt/state adapters. No mocked rules. */
export async function controlledDuel(cards: SetupCard[]) {
  const db = await loadCardDb(), core = await createCompatibleCore(), read = makeScriptReader();
  const errors: string[] = [], tracker = new DuelTracker(db, loadStrings(), 8000, 0);
  const handle = core.createDuel({ flags: OcgDuelMode.MODE_MR5, seed: [1n, 2n, 3n, 4n],
    team1: { startingLP: 8000, startingDrawCount: 0, drawCountPerTurn: 1 },
    team2: { startingLP: 8000, startingDrawCount: 0, drawCountPerTurn: 1 },
    cardReader: code => db.raw.has(code) ? toOcgCard(db.raw.get(code)!) : null,
    scriptReader: read, errorHandler: (type, message) => { if (type === OcgLogType.ERROR) errors.push(message); },
  });
  if (!handle) throw new Error('core setup failed');
  for (const name of ['constant.lua', 'utility.lua']) {
    if (!core.loadScript(handle, name, read(name)!)) throw new Error('script setup failed: ' + name);
  }
  const counts = new Map<string, number>();
  const add = (c: SetupCard) => {
    if (!db.raw.has(c.code)) throw new Error('unknown fixture code ' + c.code);
    const key = `${c.player}:${c.location}`, sequence = c.sequence ?? counts.get(key) ?? 0;
    counts.set(key, sequence + 1);
    core.duelNewCard(handle, { team: c.player, duelist: 0, controller: c.player, code: c.code,
      location: c.location as L, sequence, position: (c.position ?? (([L.MZONE, L.GRAVE, L.HAND] as number[]).includes(c.location) ? P.FACEUP_ATTACK : P.FACEDOWN_DEFENSE)) as P });
  };
  // Draw padding only; scenario cards are explicitly placed, not found via lucky seeds.
  for (const player of [0, 1] as const) for (let i = 0; i < 35; i++) add({ code: 46986414, player, location: L.DECK });
  cards.forEach(add);
  tracker.refresh(core, handle); core.startDuel(handle);
  let pending: ReturnType<typeof translatePrompt>, serial = 0;
  const history: DuelEvent[] = [], prompts: Array<{ player: PlayerIdx; prompt: Prompt }> = [];
  const duel: Duel = {
    async step(): Promise<StepResult> {
      if (pending) return { events: [], pending: { player: pending.player as PlayerIdx, prompt: pending.prompt } };
      const events: DuelEvent[] = [];
      for (let i = 0; i < 10000; i++) {
        const status = core.duelProcess(handle), messages = core.duelGetMessage(handle);
        if (errors.length) throw new Error(errors.join('; '));
        for (const m of messages) {
          if (m.type === OcgMessageType.RETRY) throw new Error('core rejected response');
          events.push(...tracker.ingest(m));
        }
        if (status === OcgProcessResult.CONTINUE && !tracker.ended) continue;
        tracker.refresh(core, handle);
        for (const m of messages) {
          const asker = 'player' in m ? m.player : 0;
          const translated = translatePrompt(m, { db, strings: loadStrings(), viewer: asker as PlayerIdx,
            chain: tracker.stateFor(asker as PlayerIdx).chain,
            card: loc => tracker.promptCard(loc, asker), cardByCode: code => tracker.promptCardByCode(code, asker), promptId: `controlled:${++serial}` });
          if (translated) { if (pending) throw new Error('multiple prompts'); pending = translated; }
        }
        history.push(...events);
        if (tracker.ended) return { events, ended: tracker.ended };
        if (!pending) throw new Error('waiting without supported prompt');
        const next = { player: pending.player as PlayerIdx, prompt: pending.prompt }; prompts.push(next);
        return { events, pending: next };
      }
      throw new Error('processing cap');
    },
    respond(player, action) {
      if (!pending || pending.player !== player || pending.prompt.promptId !== action.promptId) throw new Error('wrong/stale action');
      core.duelSetResponse(handle, adaptResponse(pending.respond(action.choose))); pending = undefined;
    },
    stateFor: viewer => tracker.stateFor(viewer), redactEvents: (events, viewer) => tracker.redactEvents(events, viewer),
    destroy: () => core.destroyDuel(handle),
  };
  const next = async () => {
    const result = await duel.step();
    if (!result.pending) throw new Error('unexpected duel ending ' + JSON.stringify(result.ended));
    return result.pending;
  };
  const answer = async (pick: (o: PromptOption) => boolean) => {
    const p = await next(), option = p.prompt.options.find(pick);
    if (!option) throw new Error(`option absent (${p.prompt.kind}): ${p.prompt.options.map(o => o.label).join(' | ')}`);
    duel.respond(p.player, { promptId: p.prompt.promptId, choose: [option.id] }); return next();
  };
  const auto = async () => {
    const p = await next();
    const passive = p.prompt.options.find(o => o.id.startsWith('pass') || /^(Go to End Phase|No)$/.test(o.label));
    if (passive) duel.respond(p.player, { promptId: p.prompt.promptId, choose: [passive.id] });
    else {
      const finish = p.prompt.options.find(o => o.id === 'finish');
      const available = p.prompt.options.filter(o => !/^(cancel|unselect:)/.test(o.id) && o.id !== 'finish');
      let accepted = false;
      const candidates = finish ? [[finish.id]] : [];
      for (let mask = 1; mask < 2 ** Math.min(available.length, 16); mask++) {
        candidates.push(available.filter((_o, i) => mask & (1 << i)).map(o => o.id));
      }
      for (const choose of candidates) {
        try { duel.respond(p.player, { promptId: p.prompt.promptId, choose }); accepted = true; break; }
        catch (error) { if (!String(error).includes('invalid prompt response')) throw error; }
      }
      if (!accepted) respondRandomly(duel, p, rng(1));
    }
    return next();
  };
  const until = async (predicate: (p: { player: PlayerIdx; prompt: Prompt }) => boolean, cap = 100) => {
    for (let i = 0; i < cap; i++) { const p = await next(); if (predicate(p)) return p; await auto(); }
    throw new Error('scenario decision cap');
  };
  return { duel, history, prompts, next, answer, auto, until };
}
