import { test, expect } from './fixtures';

test.use({ scenario: 'side-deck-component' });

test('SideDeck component displays an error prop and permits Ready retry', async ({ page, appURL }, info) => {
  await page.goto(`${appURL}/__e2e/side-deck`);
  await expect(page.getByRole('heading', { name: 'Side Deck · Game 2' })).toBeVisible();
  const cards = page.locator('.side-screen .db-card');
  await expect(cards.first()).toBeVisible();
  for (const width of [1120, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => cards.evaluateAll(elements => elements.every(element => {
      const box = element.getBoundingClientRect();
      return box.width >= 64 && box.width <= 120 && box.height >= 90 && box.height <= 180;
    }))).toBe(true);
  }
  await page.setViewportSize({ width: 1120, height: 800 });
  await cards.first().click();
  await expect(cards.first()).toHaveAttribute('aria-pressed', 'true');
  await cards.first().click();
  await expect(cards.first()).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => cards.first().locator('img').evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  const ready = page.getByRole('button', { name: 'Ready', exact: true });
  await ready.click();
  await expect(page.getByRole('alert')).toContainText('preserve the registered card pool');
  await expect(ready).toBeEnabled();
  await page.getByRole('alert').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('side-deck-rejected.png') });
  await ready.click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Waiting for opponent…', exact: true })).toBeDisabled();
  const attempts = JSON.parse((await page.getByTestId('attempts').textContent())!);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  await page.screenshot({ path: info.outputPath('side-deck-retried.png') });
});
