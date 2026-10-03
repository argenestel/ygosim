import type { Page } from '@playwright/test';
import { generateLegalSelections, type DuelEvent, type DuelState, type Prompt } from '../../packages/protocol/src/index';
import { NormalBot } from '../../packages/server/src/ai/normal';
import { BotProgress } from '../../packages/server/src/ai/progress';
import { expect } from './fixtures';

export async function observation(page: Page): Promise<{ prompt?: Prompt; state?: DuelState; busy?: boolean }> {
  return page.evaluate(() => {
    const view = (window as any).__ygosim;
    return view ? { prompt: view.prompt, state: view.state, busy: view.busy } : {};
  });
}
export async function startDuel(page: Page, appURL: string, deck?: string) {
  await page.goto(appURL);
  await expect(page.locator('.deck-card .counts')).toContainText('40');
  if (deck) {
    await page.getByRole('button', { name: 'Change deck' }).click();
    const tile = page.locator('.deck-tile').filter({ hasText: deck });
    if (!await tile.evaluate(el => el.classList.contains('active'))) await tile.getByRole('button', { name: 'Use', exact: true }).click();
    await page.getByRole('button', { name: 'Duel', exact: true }).click();
  }
  await page.getByRole('button', { name: /Solo vs Bot/ }).click();
  await page.getByRole('button', { name: 'normal', exact: true }).click();
  await page.getByRole('button', { name: 'Start Duel', exact: true }).click();
  await expect(page.locator('.board3d canvas')).toBeVisible();
  await page.getByRole('button', { name: '4×', exact: true }).click();
  await page.getByRole('button', { name: 'Auto-pass', exact: true }).click();
  await expect.poll(async () => (await observation(page)).state?.turn).toBeGreaterThan(0);
}
export async function boardClick(page: Page, kind: 'cards' | 'places', id: string) {
  await page.mouse.move(10, 10);
  await page.waitForTimeout(180);
  let point: { x: number; y: number } | undefined;
  await expect.poll(async () => {
    point = await page.evaluate(({ kind, id }) => (window as any).__ygosimBoard?.[kind]?.[id], { kind, id });
    return !!point;
  }, { timeout: 15_000, intervals: [50, 100, 200], message: `Rendered ${kind} target ${id}` }).toBe(true);
  await page.mouse.click(point!.x, point!.y);
}
export async function choose(page: Page, prompt: Prompt, ids: string[]) {
  const boardMenu = prompt.kind === 'idle' || prompt.kind === 'battle_idle';
  for (const id of ids) {
    const option = prompt.options.find(o => o.id === id)!;
    if (boardMenu && option.card) {
      if (['extra', 'grave', 'banished', 'deck'].includes(option.card.location)) {
        await boardClick(page, 'cards', option.card.uid);
        await page.locator(`.pile-card.selectable[data-card-uid="${option.card.uid}"]`).click();
      } else await boardClick(page, 'cards', option.card.uid);
      const button = page.locator(`.card-menu button[data-action-id="${id}"]`);
      await expect(button).toContainText(option.label);
      await button.click();
    } else if (prompt.kind === 'select_place') {
      await boardClick(page, 'places', id);
    } else {
      await page.locator(boardMenu ? '.phase-actions' : '.prompt-panel').getByText(option.label, { exact: true }).last().click();
    }
  }
  if (!boardMenu && (await observation(page)).prompt?.promptId === prompt.promptId && await page.locator('.prompt-panel .confirm').isVisible()) {
    await expect(page.locator('.prompt-panel .confirm')).toBeEnabled();
    await page.locator('.prompt-panel .confirm').click();
  }
  await expect.poll(async () => (await observation(page)).prompt?.promptId, { timeout: 30_000, intervals: [50, 100, 200] }).not.toBe(prompt.promptId);
}
export async function naturalDuel(page: Page, events: DuelEvent[]) {
  const player = new NormalBot();
  const progress = new BotProgress();
  let actions = 0, lastTurn = 0;
  let eventCursor = 0;
  for (; actions < 500; actions++) {
    await expect.poll(async () => {
      if (await page.locator('.result').isVisible()) return true;
      const view = await observation(page);
      return !!view.prompt && !view.busy;
    }, { timeout: 30_000, intervals: [50, 100, 200], message: 'No actionable prompt or natural result within progress deadline' }).toBe(true);
    if (await page.locator('.result').isVisible()) break;
    const { prompt, state } = await observation(page);
    expect(prompt).toBeTruthy(); expect(state).toBeTruthy();
    lastTurn = state!.turn;
    progress.observe([state!], state!.you, prompt!, events.slice(eventCursor));
    eventCursor = events.length;
    await choose(page, prompt!, player.choose(state!, prompt!).choose);
  }
  expect(actions, 'Natural duel exceeded decision cap; caps are not successful duels').toBeLessThan(500);
  expect(lastTurn).toBeGreaterThan(1);
  await expect(page.locator('.result h1')).toHaveText(/VICTORY|DEFEAT|DRAW/);
  await expect(page.locator('.result')).toHaveCSS('opacity', '1');
  await expect(page.locator('.result h1')).toHaveCSS('opacity', '1');
  await expect(page.locator('.result p').first()).not.toContainText(/surrender|abort|timeout|stall/i);
  const final = (await observation(page)).state!;
  await expect(page.locator('.lp.me .lp-num')).toHaveText(String(final.lp[final.you]));
  await expect(page.locator('.lp.op .lp-num')).toHaveText(String(final.lp[final.you === 0 ? 1 : 0]));
  return { actions, lastTurn };
}

export async function advanceUntil(page: Page, done: (view: Awaited<ReturnType<typeof observation>>) => boolean, cap = 30) {
  for (let i = 0; i < cap; i++) {
    await expect.poll(async () => {
      const view = await observation(page);
      return done(view) || !!view.prompt && !view.busy;
    }, { timeout: 30_000, intervals: [50, 100, 200] }).toBe(true);
    const view = await observation(page);
    if (done(view)) return;
    const prompt = view.prompt!;
    const candidates = generateLegalSelections(prompt).candidates;
    expect(candidates.length).toBeGreaterThan(0);
    const finish = candidates.find(ids => ids.includes('finish'));
    const pass = candidates.find(ids => ids.some(id => /^(No|Do not activate|Pass)/i.test(prompt.options.find(o => o.id === id)!.label)));
    await choose(page, prompt, finish ?? pass ?? candidates[0]);
  }
  throw new Error(`Controlled scenario did not reach its expected state within ${cap} decisions`);
}
export async function initiate(page: Page, code: number, prefix?: string) {
  await advanceUntil(page, view => view.prompt?.kind === 'idle' && !view.busy);
  const p = (await observation(page)).prompt!;
  const option = p.options.find(o => o.card?.code === code && (!prefix || o.id.startsWith(prefix)));
  expect(option, `Expected card action ${code} ${prefix ?? ''}`).toBeTruthy();
  await choose(page, p, [option!.id]);
}
