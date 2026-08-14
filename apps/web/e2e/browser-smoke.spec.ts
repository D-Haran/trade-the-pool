import { expect, test } from '@playwright/test';

test('public tournament browser renders without horizontal overflow', async ({ page }) => {
  await page.goto('/tournaments');
  await expect(page.getByRole('heading', { name: 'Tournaments' })).toBeVisible();
  await expect(page.getByText('Open Championship')).toBeVisible({ timeout: 20_000 });
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
});

test('wallet login has a deterministic no-extension state', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Prove wallet ownership.' })).toBeVisible();
  await expect(page.getByText('No compatible Solana wallet detected')).toBeVisible();
  await expect(page.getByText('Local development access')).toBeVisible();
});
