import { expect, test } from '@playwright/test';

test('public tournament browser renders without horizontal overflow', async ({ page }) => {
  await page.goto('/tournaments');
  await expect(page.getByRole('heading', { name: 'Tournaments' })).toBeVisible();
  await expect(page.getByText('Open Championship')).toBeVisible();
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
});
