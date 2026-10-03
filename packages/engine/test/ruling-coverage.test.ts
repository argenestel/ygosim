import { describe, expect, it } from 'vitest';
import type { PromptOption } from '@ygosim/protocol';
import { controlledDuel, L, P, type SetupCard } from './helpers/controlled-duel.js';

const hand = (code: number, player: 0 | 1 = 0): SetupCard => ({ code, player, location: L.HAND });
const field = (code: number, player: 0 | 1 = 0, sequence = 0): SetupCard => ({ code, player, location: L.MZONE, sequence, position: P.FACEUP_ATTACK });
const set = (code: number, player: 0 | 1 = 1): SetupCard => ({ code, player, location: L.SZONE, position: P.FACEDOWN_DEFENSE });
const idle = (p: { player: number; prompt: { kind: string } }) => p.player === 0 && p.prompt.kind === 'idle';
const activate = (code: number) => (o: PromptOption) => o.card?.code === code && o.id.startsWith('activate:');

describe('independent ruling outcomes (sources in docs/RULING-COVERAGE.md)', () => {
  it.each([[26202165, 78010363], [78010363, 26202165]])('player chooses mandatory chain order %s then %s', async (first, second) => {
    const h = await controlledDuel([hand(53129443), field(26202165), field(78010363, 0, 1), { code: 9365703, player: 0, location: L.DECK }]);
    try {
      await h.until(idle); await h.answer(activate(53129443));
      const p = await h.until(p => p.prompt.kind === 'select_chain' && p.prompt.options.some(o => o.card?.code === first));
      expect(p.prompt.options.filter(o => o.card).map(o => o.card?.code).sort()).toEqual([26202165, 78010363]);
      await h.answer(o => o.card?.code === first);
      await h.until(idle);
      expect(h.history.filter(e => e.t === 'activate').slice(1).map(e => e.card.code)).toEqual([first, second]);
      expect(h.history.filter(e => e.t === 'chain_solved').map(e => e.chainLink)).toEqual([1, 2, 1]);
    } finally { h.duel.destroy(); }
  });

  it.each([false, true])('face-up Extra Pendulums respect available Link-arrow zones (Link present: %s)', async linked => {
    const cards: SetupCard[] = [hand(15146890), hand(51531505), hand(19230407), hand(19230407), field(16178681), field(16178681, 0, 1)];
    if (linked) cards.push(field(1861629, 0, 5));
    const h = await controlledDuel(cards);
    try {
      await h.until(idle);
      for (let i = 0; i < 2; i++) {
        await h.answer(activate(19230407)); await h.until(p => p.prompt.kind === 'select_card');
        await h.answer(o => o.card?.code === 16178681); await h.until(idle);
      }
      expect(h.duel.stateFor(0).cards.filter(c => c.code === 16178681 && c.location === 'extra' && c.position === 'faceup')).toHaveLength(2);
      await h.answer(activate(15146890)); await h.until(idle);
      await h.answer(activate(51531505)); await h.until(idle);
      await h.answer(o => o.id.startsWith('special_summon:') && [15146890, 51531505].includes(o.card?.code ?? 0));
      const p = await h.until(p => p.prompt.kind === 'select_card');
      const pendulums = p.prompt.options.filter(o => o.card?.code === 16178681);
      expect(pendulums).toHaveLength(2);
      await h.answer(o => o.card?.code === 16178681 && o.id.startsWith('select:'));
      if (linked) await h.answer(o => o.card?.code === 16178681 && o.id.startsWith('select:'));
      await h.until(idle);
      const summoned = h.duel.stateFor(0).cards.filter(c => c.code === 16178681 && ['mzone', 'emzone'].includes(c.location));
      expect(summoned).toHaveLength(linked ? 2 : 1);
      if (linked) expect(summoned.map(c => c.sequence).sort()).toEqual([0, 2]);
      else expect(summoned[0].location).toBe('emzone');
    } finally { h.duel.destroy(); }
  });

  it('SEGOC places both mandatory player groups before optional groups', async () => {
    const h = await controlledDuel([hand(53129443), field(26202165), field(52624755, 0, 1), field(78010363, 1), field(52624755, 1, 1),
      { code: 52624755, player: 0, location: L.DECK }, { code: 52624755, player: 1, location: L.DECK },
      { code: 9365703, player: 0, location: L.DECK }, { code: 9365703, player: 1, location: L.DECK }]);
    try {
      await h.until(idle); await h.answer(activate(53129443));
      for (let i = 0; i < 80; i++) {
        const p = await h.next();
        if (idle(p)) break;
        if (p.prompt.kind === 'select_effect_yn') await h.answer(o => o.label === 'Yes');
        else if (p.prompt.kind === 'select_chain' && p.prompt.options.some(o => o.card?.code === 52624755)) await h.answer(o => o.card?.code === 52624755);
        else await h.auto();
      }
      expect(h.history.filter(e => e.t === 'activate').map(e => [e.card.code, e.card.controller, e.chainLink])).toEqual([
        [53129443, 0, 1], [26202165, 0, 1], [78010363, 1, 2], [52624755, 0, 3], [52624755, 1, 4],
      ]);
      expect(h.history.filter(e => e.t === 'chain_solved').map(e => e.chainLink)).toEqual([1, 4, 3, 2, 1]);
    } finally { h.duel.destroy(); }
  });

  it('an optional graveyard trigger can be declined without suppressing the mandatory trigger', async () => {
    const h = await controlledDuel([hand(53129443), field(26202165), field(52624755, 0, 1), { code: 52624755, player: 0, location: L.DECK }]);
    try {
      await h.until(idle); await h.answer(activate(53129443)); await h.until(idle);
      expect(h.history.filter(e => e.t === 'activate').map(e => e.card.code)).toEqual([53129443, 26202165]);
      expect(h.duel.stateFor(0).cards.some(c => c.code === 52624755 && c.location === 'grave')).toBe(true);
    } finally { h.duel.destroy(); }
  });

  it('Ash discard cost remains paid when Divine Wrath negates its activation', async () => {
    const h = await controlledDuel([hand(55144522), hand(14558127, 1), set(49010598, 0), hand(89631139)]);
    try {
      await h.until(idle); await h.answer(activate(55144522));
      await h.until(p => p.player === 1 && p.prompt.options.some(o => o.card?.code === 14558127)); await h.answer(o => o.card?.code === 14558127);
      const p = await h.until(p => p.player === 0 && p.prompt.options.some(o => o.card?.code === 49010598));
      expect(h.duel.stateFor(1).cards.some(c => c.code === 14558127 && c.location === 'grave')).toBe(true);
      expect(p.prompt.kind).toBe('select_chain'); await h.answer(o => o.card?.code === 49010598);
      await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === 89631139); await h.until(idle);
      expect(h.history.flatMap(e => e.t === 'draw' && e.player === 0 ? e.cards : [])).toHaveLength(2);
      expect(h.duel.stateFor(0).cards.some(c => c.code === 89631139 && c.location === 'grave')).toBe(true);
      expect(h.duel.stateFor(1).cards.some(c => c.code === 14558127 && c.location === 'grave')).toBe(true);
    } finally { h.duel.destroy(); }
  });

  it('chained Lance makes the selected monster immune to Book, then expires at End Phase', async () => {
    const h = await controlledDuel([hand(14087893), field(89631139, 1), set(27243130)]);
    try {
      await h.until(idle); await h.answer(activate(14087893)); await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === 89631139);
      await h.until(p => p.player === 1 && p.prompt.options.some(o => o.card?.code === 27243130)); await h.answer(o => o.card?.code === 27243130);
      await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === 89631139); await h.until(idle);
      expect(h.duel.stateFor(0).cards.find(c => c.code === 89631139)).toMatchObject({ position: 'atk', atk: 2200 });
      await h.until(p => p.player === 1 && p.prompt.kind === 'idle');
      expect(h.duel.stateFor(0).cards.find(c => c.code === 89631139)).toMatchObject({ position: 'atk', atk: 3000 });
    } finally { h.duel.destroy(); }
  });

  it('Snatch Steal changes controller, not owner; destroying it returns control', async () => {
    const h = await controlledDuel([hand(45986603), hand(5318639), field(89631139, 1)]);
    try {
      await h.until(idle); await h.answer(activate(45986603)); await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === 89631139); await h.until(idle);
      expect(h.duel.stateFor(0).cards.find(c => c.code === 89631139)).toMatchObject({ owner: 1, controller: 0 });
      await h.answer(activate(5318639)); await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === 45986603); await h.until(idle);
      expect(h.duel.stateFor(0).cards.find(c => c.code === 89631139)).toMatchObject({ owner: 1, controller: 1 });
    } finally { h.duel.destroy(); }
  });

  it('Scapegoat tokens disappear rather than entering the graveyard when destroyed', async () => {
    const h = await controlledDuel([hand(73915051), hand(53129443)]);
    try {
      await h.until(idle); await h.answer(activate(73915051)); await h.until(idle);
      const tokens = h.duel.stateFor(0).cards.filter(c => c.location === 'mzone');
      expect(tokens).toHaveLength(4); expect(tokens.every(c => c.atk === 0 && c.def === 0 && c.position === 'def')).toBe(true);
      await h.answer(activate(53129443)); await h.until(idle);
      expect(h.duel.stateFor(0).cards.filter(c => c.location === 'mzone')).toHaveLength(0);
      expect(h.duel.stateFor(0).cards.filter(c => tokens.some(t => t.uid === c.uid))).toHaveLength(0);
    } finally { h.duel.destroy(); }
  });

  it('returning an Xyz monster to Extra sends its attached materials to GY', async () => {
    const h = await controlledDuel([field(69140098), field(69140098, 0, 1), { code: 84013237, player: 0, location: L.EXTRA }, set(94192409)]);
    try {
      await h.until(idle); await h.answer(o => o.card?.code === 84013237 && o.id.startsWith('special_summon:')); await h.until(idle);
      expect(h.duel.stateFor(0).cards.find(c => c.code === 84013237)?.overlays).toHaveLength(2);
      await h.until(p => p.player === 1 && p.prompt.kind === 'idle'); await h.answer(activate(94192409));
      await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === 84013237);
      await h.until(p => p.player === 1 && p.prompt.kind === 'idle');
      expect(h.duel.stateFor(0).cards.find(c => c.code === 84013237)).toMatchObject({ location: 'extra' });
      expect(h.duel.stateFor(0).cards.filter(c => c.code === 69140098 && c.location === 'grave')).toHaveLength(2);
    } finally { h.duel.destroy(); }
  });

  it('United We Stand continuously recalculates when another friendly monster leaves', async () => {
    const h = await controlledDuel([hand(56747793), hand(14087893), field(89631139), field(69140098, 0, 1)]);
    try {
      await h.until(idle); await h.answer(activate(56747793)); await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === 89631139); await h.until(idle);
      expect(h.duel.stateFor(0).cards.find(c => c.code === 89631139)?.atk).toBe(4600);
      await h.answer(activate(14087893)); await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === 69140098); await h.until(idle);
      expect(h.duel.stateFor(0).cards.find(c => c.code === 89631139)?.atk).toBe(3800);
    } finally { h.duel.destroy(); }
  });

  it('Breaker gains one Spell Counter and spends it as cost before destruction resolves', async () => {
    const h = await controlledDuel([hand(71413901), set(44095762)]);
    try {
      await h.until(idle); await h.answer(o => o.id.startsWith('summon:') && o.card?.code === 71413901); await h.until(idle);
      const breaker = h.duel.stateFor(0).cards.find(c => c.code === 71413901)!;
      expect(breaker.atk).toBe(1900); expect(Object.values(breaker.counters ?? {})).toEqual([1]);
      await h.answer(activate(71413901));
      expect(h.duel.stateFor(0).cards.find(c => c.code === 71413901)?.atk).toBe(1600);
      await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.location === 'szone'); await h.until(idle);
      expect(Object.values(h.duel.stateFor(0).cards.find(c => c.code === 71413901)?.counters ?? {}).reduce((a, b) => a + b, 0)).toBe(0);
      expect(h.duel.stateFor(1).cards.find(c => c.code === 44095762)?.location).toBe('grave');
    } finally { h.duel.destroy(); }
  });

  it('Marshmallon survives battle destruction but not Raigeki effect destruction', async () => {
    const h = await controlledDuel([field(31305911), field(89631139, 1), hand(12580477, 1)]);
    try {
      await h.until(p => p.player === 1 && p.prompt.kind === 'idle'); await h.answer(o => /Go to Battle Phase/.test(o.label));
      await h.until(p => p.prompt.kind === 'battle_idle'); await h.answer(o => /attack/i.test(o.label) && !!o.card);
      await h.until(p => p.prompt.kind === 'select_card'); await h.answer(o => o.card?.code === 31305911); await h.until(p => p.prompt.kind === 'battle_idle');
      expect(h.duel.stateFor(0).cards.find(c => c.code === 31305911)?.location).toBe('mzone');
      expect(h.duel.stateFor(0).lp).toEqual([5300, 8000]);
      await h.answer(o => /Main Phase 2/.test(o.label)); await h.until(p => p.player === 1 && p.prompt.kind === 'idle');
      await h.answer(activate(12580477)); await h.until(p => p.player === 1 && p.prompt.kind === 'idle');
      expect(h.duel.stateFor(0).cards.find(c => c.code === 31305911)?.location).toBe('grave');
    } finally { h.duel.destroy(); }
  });
});
