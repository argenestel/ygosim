import { describe, expect, it } from 'vitest';
import type { PromptOption } from '@ygosim/protocol';
import { controlledDuel, L, P, type SetupCard } from './helpers/controlled-duel.js';

const BLUE = 89631139, RAI = 12580477, MST = 5318639, BOOK = 14087893, COMPULSE = 94192409;
const hand = (code: number, player: 0 | 1 = 0): SetupCard => ({ code, player, location: L.HAND });
const field = (code: number, player: 0 | 1 = 0, sequence = 0): SetupCard => ({ code, player, location: L.MZONE, sequence, position: P.FACEUP_ATTACK });
const trap = (code: number, player: 0 | 1 = 1, sequence = 0): SetupCard => ({ code, player, location: L.SZONE, sequence, position: P.FACEDOWN_DEFENSE });
const extra = (code: number): SetupCard => ({ code, player: 0, location: L.EXTRA });
const action = (code: number, prefix = 'activate:') => (o: PromptOption) => o.card?.code === code && o.id.startsWith(prefix);
const idle = (p: { player: number; prompt: { kind: string } }) => p.player === 0 && p.prompt.kind === 'idle';
const onField = (cards: ReturnType<Awaited<ReturnType<typeof controlledDuel>>['duel']['stateFor']>['cards'], code: number) => cards.some(c => c.code === code && ['mzone', 'emzone'].includes(c.location));

describe('real-script chain resolution and timing', () => {
  it('MST destroys an activated Raigeki but does NOT negate it; resolves links last-in-first-out', async () => {
    const h = await controlledDuel([hand(RAI), trap(MST), field(BLUE, 1)]);
    try {
      await h.until(idle); await h.answer(action(RAI));
      await h.until(p => p.player === 1 && p.prompt.kind === 'select_chain');
      await h.answer(o => o.card?.code === MST);
      await h.until(p => p.prompt.kind === 'select_card');
      await h.answer(o => o.card?.code === RAI);
      await h.until(idle);
      expect(onField(h.duel.stateFor(1).cards, BLUE)).toBe(false);
      expect(h.history.filter(e => e.t === 'activate').map(e => e.card.code)).toEqual([RAI, MST]);
      expect(h.history.filter(e => e.t === 'chain_solved').map(e => e.chainLink)).toEqual([2, 1]);
    } finally { h.duel.destroy(); }
  });

  it('Solemn Judgment negates a spell, pays half LP, and cannot be answered with a Spell Speed 2 MST', async () => {
    const h = await controlledDuel([hand(RAI), trap(MST, 0), trap(41420027), field(BLUE, 1)]);
    try {
      await h.until(idle); await h.answer(action(RAI));
      await h.until(p => p.player === 1 && p.prompt.kind === 'select_chain'); await h.answer(o => o.card?.code === 41420027);
      await h.until(idle);
      expect(h.duel.stateFor(0).lp).toEqual([8000, 4000]);
      expect(onField(h.duel.stateFor(1).cards, BLUE)).toBe(true);
      const afterCounter = h.prompts.slice(h.prompts.findIndex(p => p.prompt.options.some(o => o.card?.code === 41420027)) + 1);
      expect(afterCounter.filter(p => p.player === 0 && p.prompt.kind === 'select_chain').flatMap(p => p.prompt.options).some(o => o.card?.code === MST)).toBe(false);
    } finally { h.duel.destroy(); }
  });

  it('a targeted Book of Moon loses its target when chained Compulsory returns the monster to hand', async () => {
    const h = await controlledDuel([hand(BOOK), trap(COMPULSE), field(BLUE, 1)]);
    try {
      await h.until(idle); await h.answer(action(BOOK)); await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === BLUE);
      await h.until(p => p.player === 1 && p.prompt.kind === 'select_chain'); await h.answer(o => o.card?.code === COMPULSE);
      await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === BLUE);
      await h.until(idle);
      expect(h.duel.stateFor(1).cards.some(c => c.code === BLUE && c.location === 'hand')).toBe(true);
      expect(onField(h.duel.stateFor(1).cards, BLUE)).toBe(false);
    } finally { h.duel.destroy(); }
  });

  it('Torrential Tribute is offered in the successful-summon window, before ignition actions', async () => {
    const h = await controlledDuel([hand(69140098), trap(53582587), field(BLUE, 1)]);
    try {
      await h.until(idle); await h.answer(action(69140098, 'summon:'));
      await h.until(p => p.player === 1 && p.prompt.kind === 'select_chain' && p.prompt.options.some(o => o.card?.code === 53582587)); await h.answer(o => o.card?.code === 53582587);
      await h.until(idle);
      expect(h.duel.stateFor(0).cards.filter(c => ['mzone', 'emzone'].includes(c.location))).toHaveLength(0);
    } finally { h.duel.destroy(); }
  });

  it('optional WHEN Peten misses timing when tributed for a summon; mandatory Sangan still triggers', async () => {
    for (const [code, triggers] of [[52624755, false], [26202165, true]] as const) {
      const h = await controlledDuel([field(code), hand(70781052), { code: 52624755, player: 0, location: L.DECK }, { code: 9365703, player: 0, location: L.DECK }]);
      try {
        await h.until(idle); await h.answer(action(70781052, 'summon:'));
        await h.until(p => p.prompt.kind === 'select_tribute'); await h.answer(o => o.card?.code === code);
        await h.until(idle);
        const offered = h.history.some(e => e.t === 'activate' && e.card.code === code)
          || h.prompts.some(p => ['select_chain', 'select_effect_yn'].includes(p.prompt.kind) && p.prompt.options.some(o => o.card?.code === code));
        expect(offered, `trigger timing for ${code}`).toBe(triggers);
      } finally { h.duel.destroy(); }
    }
  });
});

describe('turn restrictions, tributes and damage', () => {
  it('one normal summon per turn, no first-turn battle phase, newly set quick-play cannot activate', async () => {
    const h = await controlledDuel([hand(69140098), hand(46986414), hand(MST)]);
    try {
      await h.until(idle); await h.answer(action(69140098, 'summon:')); await h.until(idle);
      let p = await h.next();
      expect(p.prompt.options.some(o => o.id.startsWith('summon:'))).toBe(false);
      expect(p.prompt.options.some(o => /battle phase/i.test(o.label))).toBe(false);
      await h.answer(o => o.card?.code === MST && /set/i.test(o.label)); await h.until(idle);
      p = await h.next(); expect(p.prompt.options.some(action(MST))).toBe(false);
    } finally { h.duel.destroy(); }
  });

  it('level 8 requires two tributes; rejected one-tribute response leaves the prompt retryable', async () => {
    const h = await controlledDuel([hand(BLUE), field(69140098), field(46986414, 0, 1)]);
    try {
      await h.until(idle); await h.answer(action(BLUE, 'summon:')); await h.until(p => p.prompt.kind === 'select_tribute');
      const p = await h.next(), tributes = p.prompt.options.filter(o => o.card);
      expect(() => h.duel.respond(p.player, { promptId: p.prompt.promptId, choose: [tributes[0].id] })).toThrow(/tributes.*need at least 2/);
      expect((await h.next()).prompt.promptId).toBe(p.prompt.promptId);
      h.duel.respond(p.player, { promptId: p.prompt.promptId, choose: tributes.map(o => o.id) }); await h.until(idle);
      expect(onField(h.duel.stateFor(0).cards, BLUE)).toBe(true);
    } finally { h.duel.destroy(); }
  });

  it.each([['attack', P.FACEUP_ATTACK], ['defense', P.FACEUP_DEFENSE]] as const)(
    'battle against %s position applies correct damage and destruction', async (_label, position) => {
      const h = await controlledDuel([{ ...field(46986414), position }, field(BLUE, 1)]);
      try {
        await h.until(p => p.player === 1 && p.prompt.kind === 'idle'); await h.answer(o => /Go to Battle Phase/.test(o.label));
        await h.until(p => p.prompt.kind === 'battle_idle'); await h.answer(o => /attack/i.test(o.label) && !!o.card);
        await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === 46986414);
        await h.until(p => p.prompt.kind === 'battle_idle');
        expect(h.duel.stateFor(0).lp).toEqual(position === P.FACEUP_ATTACK ? [7500, 8000] : [8000, 8000]);
        expect(onField(h.duel.stateFor(0).cards, 46986414)).toBe(false);
      } finally { h.duel.destroy(); }
    });
});

const summonCases = [
  { kind: 'fusion', code: 2129638, cards: [hand(24094653), hand(BLUE), hand(BLUE), extra(2129638)], initiate: action(24094653) },
  { kind: 'synchro', code: 60800381, cards: [field(63977008), field(9365703, 0, 1), extra(60800381)], initiate: action(60800381, 'special_summon:') },
  { kind: 'xyz', code: 84013237, cards: [field(69140098), field(69140098, 0, 1), extra(84013237)], initiate: action(84013237, 'special_summon:') },
  { kind: 'link', code: 2857636, cards: [field(63977008), field(70095154, 0, 1), extra(2857636)], initiate: action(2857636, 'special_summon:') },
  { kind: 'ritual', code: 5405694, cards: [hand(55761792), hand(5405694), hand(BLUE)], initiate: action(55761792) },
];
describe('real-script Extra Deck and ritual mechanics', () => {
  for (const scenario of summonCases) {
    const { kind, code, cards, initiate } = scenario;
    it(`${kind} summon consumes materials and emits the right summon kind`, async () => {
      const h = await controlledDuel(cards);
      try {
        await h.until(idle); await h.answer(initiate); await h.until(idle);
        expect(onField(h.duel.stateFor(0).cards, code)).toBe(true);
        expect(h.history).toContainEqual(expect.objectContaining({ t: 'summon', kind, card: expect.objectContaining({ code }) }));
        const summoned = h.duel.stateFor(0).cards.find(c => c.code === code && ['mzone', 'emzone'].includes(c.location))!;
        if (kind === 'xyz') expect(summoned.overlays).toHaveLength(2);
        else expect(h.duel.stateFor(0).cards.filter(c => c.location === 'grave')).toHaveLength(kind === 'fusion' ? 3 : 2);
      } finally { h.duel.destroy(); }
    });
    it(`a properly summoned ${kind} monster revived by Monster Reborn emits special`, async () => {
      const revived = kind === 'fusion' ? 23995346 : code;
      const setup = kind === 'fusion' ? [hand(24094653), hand(BLUE), hand(BLUE), hand(BLUE), extra(revived)] : cards;
      const h = await controlledDuel([...setup, hand(53129443), hand(83764718)]);
      try {
        await h.until(idle); await h.answer(initiate); await h.until(idle);
        expect(h.history).toContainEqual(expect.objectContaining({ t: 'summon', kind, card: expect.objectContaining({ code: revived }) }));
        await h.answer(action(53129443)); await h.until(idle);
        expect(h.duel.stateFor(0).cards.some(c => c.code === revived && c.location === 'grave')).toBe(true);
        const start = h.history.length;
        await h.answer(action(83764718));
        await h.until(p => p.prompt.kind === 'select_card' && p.prompt.options.some(o => o.card?.code === revived));
        await h.answer(o => o.card?.code === revived); await h.until(idle);
        expect(onField(h.duel.stateFor(0).cards, revived)).toBe(true);
        expect(h.history.slice(start).filter(e => e.t === 'summon')).toEqual([
          expect.objectContaining({ t: 'summon', kind: 'special', card: expect.objectContaining({ code: revived }) }),
        ]);
      } finally { h.duel.destroy(); }
    });
  }
  it('Twin Burst contact summon emits special because it is not a Fusion Summon', async () => {
    const code = 2129638;
    const h = await controlledDuel([field(BLUE), field(BLUE, 0, 1), extra(code)]);
    try {
      await h.until(idle); await h.answer(action(code, 'special_summon:')); await h.until(idle);
      expect(onField(h.duel.stateFor(0).cards, code)).toBe(true);
      expect(h.history).toContainEqual(expect.objectContaining({ t: 'summon', kind: 'special', card: expect.objectContaining({ code }) }));
    } finally { h.duel.destroy(); }
  });
  it('a Pendulum procedure emits pendulum for multiple summoned monsters', async () => {
    const h = await controlledDuel([hand(15146890), hand(51531505), hand(16178681), hand(46986414)]);
    try {
      await h.until(idle); await h.answer(action(15146890)); await h.until(idle);
      await h.answer(action(51531505)); await h.until(idle);
      await h.answer(o => o.id.startsWith('special_summon:') && [15146890, 51531505].includes(o.card?.code ?? 0));
      await h.until(p => p.prompt.kind === 'select_card');
      await h.answer(o => o.id.startsWith('select:') && o.card?.code === 16178681);
      await h.answer(o => o.id.startsWith('select:') && o.card?.code === 46986414);
      await h.until(idle);
      for (const code of [16178681, 46986414]) {
        expect(onField(h.duel.stateFor(0).cards, code)).toBe(true);
        expect(h.history).toContainEqual(expect.objectContaining({ t: 'summon', kind: 'pendulum', card: expect.objectContaining({ code }) }));
      }
    } finally { h.duel.destroy(); }
  });
});
