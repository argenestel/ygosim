import { test, expect } from './fixtures';
import { advanceUntil, boardClick, choose, initiate, naturalDuel, observation, startDuel } from './gameplay';

test('surrender, return, and restart in the same session', async ({ page, appURL }, info) => {
  await startDuel(page, appURL);
  const first = await observation(page);
  await page.getByRole('button', { name: 'Surrender', exact: true }).click();
  await expect(page.locator('.result h1')).toHaveText('DEFEAT');
  await page.screenshot({ path: info.outputPath('surrender.png') });
  await page.getByRole('button', { name: 'Return', exact: true }).click();
  await page.getByRole('button', { name: /Solo vs Bot/ }).click();
  await page.getByRole('button', { name: 'Start Duel', exact: true }).click();
  await expect(page.locator('.board3d canvas')).toBeVisible();
  await expect.poll(async () => (await observation(page)).state?.turn).toBeGreaterThan(0);
  expect((await observation(page)).state?.lp).toEqual([8000, 8000]);
  expect(first.state).toBeTruthy();
  await page.getByRole('button', { name: 'Surrender', exact: true }).click();
  await expect(page.locator('.result h1')).toHaveText('DEFEAT');
});

const procedures = [
  { kind: 'fusion', start: 24094653, prefix: 'activate:', result: 2129638 },
  { kind: 'synchro', start: 60800381, prefix: 'special_summon:', result: 60800381 },
  { kind: 'xyz', start: 84013237, prefix: 'special_summon:', result: 84013237 },
  { kind: 'link', start: 2857636, prefix: 'special_summon:', result: 2857636 },
  { kind: 'ritual', start: 55761792, prefix: 'activate:', result: 5405694 },
] as const;

test.describe('controlled double-tribute opening', () => {
  test.use({ scenario: 'double-tribute' });
  test('one permitted double-tribute monster can satisfy a Level 8 summon', async ({ page, appURL }, info) => {
    await startDuel(page, appURL);
    await initiate(page, 89631139, 'summon:');
    await advanceUntil(page, view => view.prompt?.kind === 'select_tribute');
    const p = (await observation(page)).prompt!;
    const option = p.options.find(o => o.card?.code === 17444133)!;
    const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
    await expect(confirm).toBeDisabled();
    await boardClick(page, 'cards', option.card!.uid);
    await expect(confirm).toBeEnabled();
    await page.screenshot({ path: info.outputPath('double-tribute-valid.png') });
    await confirm.click();
    await expect.poll(async () => (await observation(page)).prompt?.promptId).not.toBe(p.promptId);
    await advanceUntil(page, view => !!view.state?.cards.some(c => c.code === 89631139 && c.location === 'mzone'));
  });
});

for (const procedure of procedures) {
  test.describe(`controlled ${procedure.kind} procedure`, () => {
    test.use({ scenario: procedure.kind });
    test('real card/menu, material selection, zones, and authoritative summon event', async ({ page, appURL, duelEvents }, info) => {
      await startDuel(page, appURL);
      await initiate(page, procedure.start, procedure.prefix);
      await advanceUntil(page, view => !!view.state?.cards.some(c => c.code === procedure.result && ['mzone', 'emzone'].includes(c.location)));
      expect(duelEvents).toContainEqual(expect.objectContaining({ t: 'summon', kind: procedure.kind, card: expect.objectContaining({ code: procedure.result }) }));
      await page.screenshot({ path: info.outputPath(`${procedure.kind}-summoned.png`) });
    });
  });
}

test.describe('controlled Pendulum procedure', () => {
  test.use({ scenario: 'pendulum' });
  test('activate both scales then select and summon two monsters', async ({ page, appURL, duelEvents }, info) => {
    await startDuel(page, appURL);
    await initiate(page, 15146890, 'activate:');
    await initiate(page, 51531505, 'activate:');
    await initiate(page, 15146890, 'special_summon:');
    for (const code of [16178681, 46986414]) {
      await advanceUntil(page, view => view.prompt?.kind === 'select_card');
      const prompt = (await observation(page)).prompt!;
      const option = prompt.options.find(o => o.id.startsWith('select:') && o.card?.code === code);
      expect(option).toBeTruthy();
      await choose(page, prompt, [option!.id]);
    }
    await advanceUntil(page, view => [16178681, 46986414].every(code => view.state?.cards.some(c => c.code === code && c.location === 'mzone')));
    for (const code of [16178681, 46986414]) expect(duelEvents).toContainEqual(expect.objectContaining({ t: 'summon', kind: 'pendulum', card: expect.objectContaining({ code }) }));
    await page.screenshot({ path: info.outputPath('pendulum-summoned.png') });
  });
});

test('keyboard navigation activates a deck tile and returns to lobby', async ({ page, appURL }, info) => {
  await page.goto(appURL);
  await expect(page.locator('.deck-card .counts')).toContainText('40');
  await page.getByRole('button', { name: 'Change deck' }).focus();
  await page.keyboard.press('Enter');
  const tile = page.locator('.deck-tile').filter({ hasText: 'Junk Synchro' });
  await tile.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Use this deck', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '← Decks', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Duel', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /Solo vs Bot/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('keyboard-lobby.png') });
});

test.describe('mobile touch and resizing', () => {
  test.use({ scenario: 'tribute', hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test('touch targets a real 3D card after rotating to landscape', async ({ page, appURL }, info) => {
    await page.goto(appURL);
    await expect(page.locator('.deck-card .counts')).toContainText('40');
    await page.getByRole('button', { name: /Solo vs Bot/ }).tap();
    await page.getByRole('button', { name: 'Start Duel', exact: true }).tap();
    await expect(page.locator('.board3d canvas')).toBeVisible();
    await expect.poll(async () => (await observation(page)).prompt?.kind).toBe('idle');
    await expect(page.locator('.turn-banner')).toHaveCSS('opacity', '0');
    await page.screenshot({ path: info.outputPath('mobile-portrait.png') });
    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(async () => (await observation(page)).prompt?.kind).toBe('idle');
    const prompt = (await observation(page)).prompt!;
    const summon = prompt.options.find(o => o.id.startsWith('summon:') && o.card?.code === 89631139)!;
    const point = await page.evaluate(uid => (window as any).__ygosimBoard.cards[uid], summon.card!.uid);
    await page.touchscreen.tap(point.x, point.y);
    await expect(page.locator('.card-menu')).toBeVisible();
    await page.locator('.card-menu').getByRole('button', { name: summon.label, exact: true }).tap();
    await expect.poll(async () => (await observation(page)).prompt?.kind).toBe('select_tribute');
    await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath('mobile-landscape-tribute.png') });
  });
});

test('server disconnect is terminal and offers Return instead of infinite thinking', async ({ page, appURL, disconnectServer }, info) => {
  await startDuel(page, appURL);
  await disconnectServer();
  await expect(page.getByRole('button', { name: 'Return to menu', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/disconnect|connection|closed/i);
  await page.screenshot({ path: info.outputPath('disconnected.png') });
  await page.getByRole('button', { name: 'Return to menu', exact: true }).click();
  await expect(page.getByRole('button', { name: /Solo vs Bot/ })).toBeVisible();
});

test.describe('controlled real-core tribute opening', () => {
  test.use({ scenario: 'tribute' });
  test('two ordinary tributes require multi-selection and real board/menu clicks', async ({ page, appURL }, info) => {
    await startDuel(page, appURL);
    await expect.poll(async () => (await observation(page)).prompt?.kind).toBe('idle');
    const p = (await observation(page)).prompt!;
    const summon = p.options.find(o => o.id.startsWith('summon:') && o.card?.code === 89631139)!;
    await choose(page, p, [summon.id]);
    await expect.poll(async () => (await observation(page)).prompt?.kind).toBe('select_tribute');
    const tribute = (await observation(page)).prompt!;
    const options = tribute.options.filter(o => o.card);
    const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
    await expect(confirm).toBeDisabled();
    await boardClick(page, 'cards', options[0].card!.uid);
    await expect(confirm).toBeDisabled();
    expect((await observation(page)).prompt?.promptId).toBe(tribute.promptId);
    await boardClick(page, 'cards', options[1].card!.uid);
    await expect(confirm).toBeEnabled();
    await page.screenshot({ path: info.outputPath('two-tributes.png') });
    await confirm.click();
    await expect.poll(async () => (await observation(page)).prompt?.promptId).not.toBe(tribute.promptId);
    for (let i = 0; i < 12; i++) {
      const view = await observation(page);
      if (view.state?.cards.some(c => c.code === 89631139 && c.location === 'mzone')) break;
      await expect.poll(async () => (await observation(page)).prompt).toBeTruthy();
      const next = (await observation(page)).prompt!;
      await choose(page, next, [next.options[0].id]);
    }
    await expect.poll(async () => (await observation(page)).state?.cards.some(c => c.code === 89631139 && c.location === 'mzone')).toBe(true);
    await page.screenshot({ path: info.outputPath('tribute-summoned.png') });
  });
});

for (const deck of ['Blue Eyes Fusion', 'Junk Synchro', 'Utopia Xyz', 'Link Code Talker']) {
  test(`natural real duel: ${deck}, seed 42`, async ({ page, appURL, duelEvents }, info) => {
    test.setTimeout(600_000);
    await startDuel(page, appURL, deck);
    const result = await naturalDuel(page, duelEvents);
    await info.attach('outcome', { body: JSON.stringify({ deck, seed: 42, ...result }), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('natural-result.png') });
  });
}
