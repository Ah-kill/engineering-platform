import { test } from '@playwright/test';
import { loginAs, openWorkspace } from './helpers';

// Visual check only: `SCREENSHOTS=dir npx playwright test zz-screens`. Skipped otherwise.
const dir = process.env.SCREENSHOTS;
test.skip(!dir, 'set SCREENSHOTS=<dir> to capture');

test('capture key screens', async ({ page }, info) => {
  const tag = info.project.name;
  await loginAs(page, 'dev');
  await page.goto('/');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/${tag}-home.png` });
  await page.goto('/settings');
  await page.locator('.model-option').first().waitFor({ timeout: 60_000 });
  await page.screenshot({ path: `${dir}/${tag}-settings.png`, fullPage: true });
  await page.goto('/clients');
  await openWorkspace(page);
  await page.getByLabel('Conversation', { exact: true }).selectOption({ label: 'Refactor the retry mechanism' });
  await page.locator('.msg.plan').waitFor();
  if (tag === 'desktop') {
    await page.getByRole('button', { name: 'src' }).click();
    await page.getByRole('button', { name: 'retry.js' }).click();
    await page.locator('.monaco-editor').first().waitFor();
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${dir}/${tag}-workspace.png` });
});
