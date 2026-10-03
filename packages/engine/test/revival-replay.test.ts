import { describe, expect, it } from 'vitest';
import { controlledDuel, L, P, type SetupCard } from './helpers/controlled-duel.js';
const hand = (code: number, player: 0 | 1 = 0): SetupCard => ({ code, player, location: L.HAND });
const field = (code: number, player: 0 | 1 = 0, sequence = 0): SetupCard => ({ code, player, location: L.MZONE, sequence, position: P.FACEUP_ATTACK });
const idle = (p: { player: number; prompt: { kind: string } }) => p.player === 0 && p.prompt.kind === 'idle';
const attack = async (h: Awaited<ReturnType<typeof controlledDuel>>) => {
  await h.until(p => p.player === 1 && p.prompt.kind === 'idle'); await h.answer(o => /Go to Battle Phase/.test(o.label));
  await h.until(p => p.prompt.kind === 'battle_idle'); await h.answer(o => /attack/i.test(o.label) && !!o.card);
};

describe('revival limits, battle replay and extra-attack restrictions', () => {
  it.each([23995346, 60800381, 84013237])('Monster Reborn cannot revive improperly summoned Extra Deck monster %s', async code => {
    const h = await controlledDuel([hand(83764718), { code, player: 0, location: L.GRAVE }]);
    try {
      const p = await h.until(idle);
      expect(p.prompt.options.some(o => o.card?.code === 83764718 && o.id.startsWith('activate:'))).toBe(false);
    } finally { h.duel.destroy(); }
  });

  it('removing the attack target before the damage step offers a replay and retargets the surviving monster', async () => {
    const h = await controlledDuel([field(46986414), field(46986414, 0, 1), field(89631139, 1),
      { code: 94192409, player: 0, location: L.SZONE, position: P.FACEDOWN_DEFENSE }]);
    try {
      await attack(h); await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.sequence === 0);
      await h.until(p => p.player === 0 && p.prompt.kind === 'select_chain' && p.prompt.options.some(o => o.card?.code === 94192409));
      await h.answer(o => o.card?.code === 94192409); await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === 46986414 && o.card.sequence === 0);
      await h.until(p => p.prompt.kind === 'select_yesno'); await h.answer(o => o.label === 'Yes');
      await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === 46986414);
      await h.until(p => p.prompt.kind === 'battle_idle');
      expect(h.duel.stateFor(0).lp).toEqual([7500, 8000]);
      expect(h.duel.stateFor(0).cards.filter(c => c.code === 46986414 && c.location === 'hand')).toHaveLength(1);
      expect(h.duel.stateFor(0).cards.filter(c => c.code === 46986414 && c.location === 'grave')).toHaveLength(1);
    } finally { h.duel.destroy(); }
  });

  it('Twin Burst may attack two monsters but its extra monster attack does not permit a second direct attack', async () => {
    for (const defenders of [[], [field(46986414), field(46986414, 0, 1)]]) {
      const h = await controlledDuel([...defenders, field(2129638, 1)]);
      try {
        await attack(h);
        if (defenders.length) { await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => !!o.card); }
        let p = await h.until(p => p.prompt.kind === 'battle_idle');
        const second = p.prompt.options.find(o => /attack/i.test(o.label) && o.card?.code === 2129638);
        if (defenders.length) {
          expect(second).toBeDefined(); await h.answer(o => o.id === second!.id);
          await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => !!o.card);
          p = await h.until(p => p.prompt.kind === 'battle_idle');
          expect(h.duel.stateFor(0).lp).toEqual([7000, 8000]);
        } else { expect(second).toBeUndefined(); expect(h.duel.stateFor(0).lp).toEqual([5000, 8000]); }
        expect(p.prompt.options.some(o => /attack/i.test(o.label) && !!o.card)).toBe(false);
      } finally { h.duel.destroy(); }
    }
  });
});
