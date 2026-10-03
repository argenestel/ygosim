import { describe, expect, it } from 'vitest';
import type { PromptOption } from '@ygosim/protocol';
import { controlledDuel, L, P, type SetupCard } from './helpers/controlled-duel.js';
const hand = (code: number, player: 0 | 1 = 0): SetupCard => ({ code, player, location: L.HAND });
const field = (code: number, player: 0 | 1 = 0, sequence = 0): SetupCard => ({ code, player, location: L.MZONE, sequence, position: P.FACEUP_ATTACK });
const extra = (code: number): SetupCard => ({ code, player: 0, location: L.EXTRA });
const set = (code: number, player: 0 | 1 = 1, sequence = 0): SetupCard => ({ code, player, location: L.SZONE, sequence, position: P.FACEDOWN_DEFENSE });
const idle = (p: { player: number; prompt: { kind: string } }) => p.player === 0 && p.prompt.kind === 'idle';
const activate = (code: number) => (o: PromptOption) => o.card?.code === code && o.id.startsWith('activate:');

// These are controlled legal game states, not constructed tournament-legal decks.
// Banned cards such as Pot of Greed isolate rulings without banlist confounders.
describe('advanced timing and restrictions using official scripts', () => {
  it('Ash negates drawing without negating activation; its hard once-per-turn applies across copies', async () => {
    const h = await controlledDuel([hand(55144522), hand(55144522), hand(14558127, 1), hand(14558127, 1)]);
    try {
      await h.until(idle); await h.answer(activate(55144522));
      await h.until(p => p.player === 1 && p.prompt.kind === 'select_chain' && p.prompt.options.some(o => o.card?.code === 14558127));
      await h.answer(o => o.card?.code === 14558127); await h.until(idle);
      expect(h.history.filter(e => e.t === 'draw' && e.player === 0)).toHaveLength(0);
      const marker = h.prompts.length;
      await h.answer(activate(55144522)); await h.until(idle);
      expect(h.prompts.slice(marker).filter(p => p.player === 1 && p.prompt.kind === 'select_chain').flatMap(p => p.prompt.options).some(o => o.card?.code === 14558127)).toBe(false);
      expect(h.history.flatMap(e => e.t === 'draw' && e.player === 0 ? e.cards : [])).toHaveLength(2);
    } finally { h.duel.destroy(); }
  });

  it('simultaneous mandatory Sangan/Witch graveyard triggers build a chain after Raigeki resolves', async () => {
    const h = await controlledDuel([hand(12580477), field(26202165, 1), field(78010363, 1, 1),
      { code: 9365703, player: 1, location: L.DECK }, { code: 9365703, player: 1, location: L.DECK }]);
    try {
      await h.until(idle); await h.answer(activate(12580477)); await h.until(idle);
      const activations = h.history.filter(e => e.t === 'activate');
      expect(activations.map(e => e.card.code).sort()).toEqual([12580477, 26202165, 78010363].sort());
      expect(activations.slice(1).map(e => e.chainLink).sort()).toEqual([1, 2]);
      expect(h.history.filter(e => e.t === 'chain_solved').map(e => e.chainLink)).toEqual([1, 2, 1]);
      expect(h.duel.stateFor(1).cards.filter(c => c.code === 9365703 && c.location === 'hand')).toHaveLength(2);
    } finally { h.duel.destroy(); }
  });

  it('Mirror Force activates on attack declaration; destroying it with MST does not stop its destruction', async () => {
    const h = await controlledDuel([set(44095762, 0), field(89631139, 1), field(46986414, 1, 1), hand(5318639, 1)]);
    try {
      await h.until(p => p.player === 1 && p.prompt.kind === 'idle'); await h.answer(o => /Go to Battle Phase/.test(o.label));
      await h.until(p => p.prompt.kind === 'battle_idle'); await h.answer(o => /attack/i.test(o.label) && o.card?.code === 89631139);
      await h.until(p => p.player === 0 && p.prompt.kind === 'select_chain' && p.prompt.options.some(o => o.card?.code === 44095762));
      await h.answer(o => o.card?.code === 44095762);
      await h.until(p => p.player === 1 && p.prompt.kind === 'select_chain' && p.prompt.options.some(o => o.card?.code === 5318639));
      await h.answer(o => o.card?.code === 5318639); await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === 44095762);
      await h.until(p => p.prompt.kind === 'battle_idle');
      expect(h.duel.stateFor(1).cards.filter(c => c.controller === 1 && c.location === 'mzone')).toHaveLength(0);
      expect(h.duel.stateFor(0).lp).toEqual([8000, 8000]);
    } finally { h.duel.destroy(); }
  });

  it('Effect Veiler is available in the opponent main phase but not the battle phase', async () => {
    const h = await controlledDuel([hand(97268402), field(70095154, 1), hand(55144522, 1)]);
    try {
      await h.until(p => p.player === 1 && p.prompt.kind === 'idle'); await h.answer(activate(55144522));
      await h.until(p => p.player === 0 && p.prompt.kind === 'select_chain' && p.prompt.options.some(o => o.card?.code === 97268402));
      await h.answer(o => o.id.startsWith('pass')); await h.until(p => p.player === 1 && p.prompt.kind === 'idle');
      await h.answer(o => /Go to Battle Phase/.test(o.label)); await h.until(p => p.prompt.kind === 'battle_idle');
      // The main-phase-end response window still permits Veiler; exclude it.
      const marker = h.prompts.length;
      await h.answer(o => /attack/i.test(o.label) && !!o.card); await h.until(p => p.prompt.kind === 'battle_idle');
      expect(h.prompts.slice(marker).filter(p => p.player === 0 && p.prompt.kind === 'select_chain').flatMap(p => p.prompt.options).some(o => o.card?.code === 97268402)).toBe(false);
      expect(h.duel.stateFor(0).lp).toEqual([5900, 8000]);
    } finally { h.duel.destroy(); }
  });

  it.each([
    ['Synchro without a tuner', [field(69140098), field(9365703, 0, 1), extra(60800381)], 60800381],
    ['Xyz with mismatched levels', [field(69140098), field(63977008, 0, 1), extra(84013237)], 84013237],
    ['Link requiring effect monsters with normal materials', [field(69140098), field(69140098, 0, 1), extra(2857636)], 2857636],
    ['Ritual with insufficient levels', [hand(55761792), hand(5405694), hand(9365703)], 55761792],
  ] as const)('%s is not offered', async (_label, cards, code) => {
    const h = await controlledDuel([...cards]);
    try {
      const p = await h.until(idle);
      expect(p.prompt.options.some(o => o.card?.code === code && /^(activate:|special_summon:)/.test(o.id))).toBe(false);
    } finally { h.duel.destroy(); }
  });

  it('Pendulum scales 1/8 summon level 7, exclude level 8, send used Pendulum to face-up Extra Deck', async () => {
    const h = await controlledDuel([
      hand(15146890), hand(51531505), hand(16178681), hand(89631139), hand(70781052),
    ]);
    try {
      await h.until(idle); await h.answer(activate(15146890)); await h.until(idle);
      await h.answer(activate(51531505)); await h.until(idle);
      await h.answer(o => o.id.startsWith('special_summon:') && [15146890, 51531505].includes(o.card?.code ?? 0));
      const selection = await h.until(p => p.prompt.kind === 'select_card');
      expect(selection.prompt.options.some(o => o.card?.code === 89631139)).toBe(false);
      await h.answer(o => o.card?.code === 16178681); await h.until(idle);
      expect(h.duel.stateFor(0).cards.some(c => c.code === 16178681 && c.location === 'mzone')).toBe(true);
      // Tribute the Pendulum for Summoned Skull: Pendulum goes to face-up Extra, not GY.
      await h.answer(o => o.card?.code === 70781052 && o.id.startsWith('summon:')); await h.until(p => p.prompt.kind === 'select_tribute');
      await h.answer(o => o.card?.code === 16178681); await h.until(idle);
      expect(h.duel.stateFor(0).cards.some(c => c.code === 16178681 && c.location === 'extra' && c.position === 'faceup')).toBe(true);
      expect((await h.next()).prompt.options.some(o => o.id.startsWith('special_summon:') && [15146890, 51531505].includes(o.card?.code ?? 0))).toBe(false);
    } finally { h.duel.destroy(); }
  });
});
