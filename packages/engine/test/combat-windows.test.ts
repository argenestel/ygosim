import { describe, expect, it } from 'vitest';
import { controlledDuel, L, P, type SetupCard } from './helpers/controlled-duel.js';
const hand = (code: number, player: 0 | 1 = 0): SetupCard => ({ code, player, location: L.HAND });
const field = (code: number, player: 0 | 1 = 0, sequence = 0, position: number = P.FACEUP_ATTACK): SetupCard => ({ code, player, location: L.MZONE, sequence, position });
const set = (code: number, player: 0 | 1 = 0): SetupCard => ({ code, player, location: L.SZONE, position: P.FACEDOWN_DEFENSE });
const idle = (p: { player: number; prompt: { kind: string } }) => p.player === 0 && p.prompt.kind === 'idle';

describe('combat, summon negation and timing windows', () => {
  it('Solemn Judgment negates a normal summon before Torrential can respond to a successful summon', async () => {
    const h = await controlledDuel([hand(69140098), set(41420027, 1), { ...set(53582587, 1), sequence: 1 }]);
    try {
      await h.until(idle); await h.answer(o => o.id.startsWith('summon:'));
      const p = await h.until(p => p.player === 1 && p.prompt.options.some(o => o.card?.code === 41420027));
      expect(p.prompt.options.some(o => o.card?.code === 53582587)).toBe(false);
      await h.answer(o => o.card?.code === 41420027); await h.until(idle);
      expect(h.duel.stateFor(0).lp).toEqual([8000, 4000]);
      expect(h.duel.stateFor(0).cards.some(c => c.code === 69140098 && c.location === 'grave')).toBe(true);
      expect((await h.next()).prompt.options.some(o => o.id.startsWith('summon:'))).toBe(false);
    } finally { h.duel.destroy(); }
  });

  it('Book of Moon removes an attacker from attack position and prevents damage', async () => {
    const h = await controlledDuel([set(14087893), field(89631139, 1)]);
    try {
      await h.until(p => p.player === 1 && p.prompt.kind === 'idle'); await h.answer(o => /Go to Battle Phase/.test(o.label));
      await h.until(p => p.prompt.kind === 'battle_idle'); await h.answer(o => /attack/i.test(o.label) && !!o.card);
      await h.until(p => p.player === 0 && p.prompt.kind === 'select_chain' && p.prompt.options.some(o => o.card?.code === 14087893));
      await h.answer(o => o.card?.code === 14087893); await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === 89631139);
      await h.until(p => p.prompt.kind === 'battle_idle');
      expect(h.duel.stateFor(0).lp).toEqual([8000, 8000]);
      expect(h.duel.stateFor(1).cards.find(c => c.code === 89631139 && c.location === 'mzone')?.position).toBe('facedown_def');
    } finally { h.duel.destroy(); }
  });

  it('destroying a continuous spell before resolution stops its effect (unlike a normal spell)', async () => {
    // Fire Formation - Tenki searches only if it remains face-up when its activation resolves.
    const h = await controlledDuel([hand(57103969), set(5318639, 1), { code: 96381979, player: 0, location: L.DECK }]);
    try {
      await h.until(idle); await h.answer(o => o.card?.code === 57103969 && o.id.startsWith('activate:'));
      await h.until(p => p.player === 1 && p.prompt.options.some(o => o.card?.code === 5318639)); await h.answer(o => o.card?.code === 5318639);
      await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === 57103969); await h.until(idle);
      expect(h.duel.stateFor(0).cards.some(c => c.code === 96381979 && c.location === 'hand')).toBe(false);
      expect(h.duel.stateFor(0).cards.some(c => c.code === 57103969 && c.location === 'grave')).toBe(true);
    } finally { h.duel.destroy(); }
  });

  it('a flipped Man-Eater Bug resolves after damage calculation, not at attack declaration', async () => {
    const h = await controlledDuel([field(54652250, 0, 0, P.FACEDOWN_DEFENSE), field(89631139, 1)]);
    try {
      await h.until(p => p.player === 1 && p.prompt.kind === 'idle'); await h.answer(o => /Go to Battle Phase/.test(o.label));
      await h.until(p => p.prompt.kind === 'battle_idle'); await h.answer(o => /attack/i.test(o.label) && !!o.card);
      await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === undefined || o.card.code === 54652250);
      await h.until(p => p.player === 0 && p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === 89631139);
      await h.until(p => p.prompt.kind === 'battle_idle');
      expect(h.duel.stateFor(1).cards.some(c => c.code === 89631139 && c.location === 'grave')).toBe(true);
      expect(h.duel.stateFor(0).cards.some(c => c.code === 54652250 && c.location === 'grave')).toBe(true);
      expect(h.duel.stateFor(0).lp).toEqual([8000, 8000]);
      const attack = h.history.findIndex(e => e.t === 'attack');
      const flipped = h.history.findIndex(e => e.t === 'pos_change' && e.card.code === 54652250);
      const activated = h.history.findIndex(e => e.t === 'activate' && e.card.code === 54652250);
      expect(attack).toBeLessThan(flipped); expect(flipped).toBeLessThan(activated);
    } finally { h.duel.destroy(); }
  });

  it('ordinary MST is not allowed in the damage-step response windows of a flip effect', async () => {
    const h = await controlledDuel([field(54652250, 0, 0, P.FACEDOWN_DEFENSE), field(89631139, 1), hand(5318639, 1), set(44095762, 0)]);
    try {
      await h.until(p => p.player === 1 && p.prompt.kind === 'idle'); await h.answer(o => /Go to Battle Phase/.test(o.label));
      await h.until(p => p.prompt.kind === 'battle_idle'); await h.answer(o => /attack/i.test(o.label) && !!o.card);
      await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => !!o.card);
      // Skip attack-declaration chains but stop before the flip trigger's target selection.
      await h.until(p => p.player === 0 && p.prompt.kind === 'select_card');
      const marker = h.prompts.length; await h.answer(o => o.card?.code === 89631139);
      await h.until(p => p.prompt.kind === 'battle_idle');
      const windows = h.prompts.slice(marker).filter(p => p.player === 1 && p.prompt.kind === 'select_chain');
      expect(windows.length).toBeGreaterThan(0);
      expect(windows.flatMap(p => p.prompt.options).some(o => o.card?.code === 5318639)).toBe(false);
    } finally { h.duel.destroy(); }
  });
});
