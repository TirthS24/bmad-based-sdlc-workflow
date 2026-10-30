import { expect, test } from '@playwright/test';

test('PRD-1.1 REQ-1 the greeting page says hello', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Greeting' }).click();
  await expect(page.getByRole('heading', { name: 'Hello' })).toBeVisible();
});
