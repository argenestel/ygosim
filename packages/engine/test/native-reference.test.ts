import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core.js')>();
  if (!process.env.YGOSIM_NATIVE_REFERENCE) return actual;
  const { createMirroredCore } = await import('../scripts/reference/mirrored-core.js');
  return { ...actual, createCompatibleCore: (options?: Record<string, unknown>) => createMirroredCore(actual.createCompatibleCore, options) };
});

if (!process.env.YGOSIM_NATIVE_REFERENCE) {
  it.skip('native EDOPro-core differential (set YGOSIM_NATIVE_REFERENCE to libocgcore.so)', () => {});
} else {
  // Existing rule assertions are unchanged; every core message and query is also
  // checked against a separately compiled upstream native core in lockstep.
  await import('./rules-scenarios.test.js');
  await import('./timing-advanced.test.js');
  await import('./combat-windows.test.js');
  await import('./revival-replay.test.js');
  const { createDuel, parseYdk } = await import('../src/index.js');
  const { respondRandomly, rng } = await import('../scripts/fuzz-support.js');
  const { referenceStats } = await import('../scripts/reference/mirrored-core.js');
  const names = ['blue-eyes-fusion', 'junk-synchro', 'link-code-talker', 'utopia-xyz'];
  const decks = names.map(name => parseYdk(readFileSync(new URL(`../decks/${name}.ydk`, import.meta.url), 'utf8')));
  const outcomes: object[] = [];
  afterAll(() => {
    writeFileSync(process.env.YGOSIM_REFERENCE_REPORT ?? '/tmp/ygosim-reference/differential-report.json', JSON.stringify({
      reference: 'edo9300/ygopro-core', revision: 'efc21aa433b88cd35b7c37db4072a35c58d9d435',
      sharedRules: true, ...referenceStats, outcomes,
    }, null, 2));
  });
  describe('native vs WASM complex-deck lockstep', () => {
    for (let a = 0; a < names.length; a++) for (let b = 0; b < names.length; b++) {
      it(`${names[a]} vs ${names[b]}, seed 42`, async () => {
        const duel = await createDuel({ decks: [decks[a], decks[b]], format: 'tcg', seed: 42 });
        const random = rng(42); let decisions = 0, completed = false;
        try {
          for (; decisions < 4000; decisions++) {
            const result = await duel.step();
            if (result.ended) { completed = true; break; }
            expect(result.pending).toBeDefined();
            respondRandomly(duel, result.pending!, random);
          }
          outcomes.push({ decks: [names[a], names[b]], seed: 42, decisions, completed });
          expect(completed, 'natural completion required, not just matched prefixes').toBe(true);
        } finally { duel.destroy(); }
      }, 120000);
    }
  });
  // Expected failures in the imported ruling scenarios must not conceal a
  // transport mismatch: the whole run independently requires zero mismatches.
  it('has no native/WASM message, query, or process-status mismatches', () => {
    expect(referenceStats.mismatches).toEqual([]);
    expect(referenceStats.steps).toBeGreaterThan(0);
  });
}
