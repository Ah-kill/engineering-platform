import { expect, test } from '@playwright/test';
import { loginAs, openWorkspace } from './helpers';

// Runs on a Pixel 7 viewport, after the desktop tests have set up the data.
test.describe('on a phone', () => {
  test('pages fit the screen without sideways scrolling', async ({ page }) => {
    await loginAs(page, 'dev');
    for (const path of ['/clients', '/settings', '/account']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, path).toBeLessThanOrEqual(1);
    }
  });

  test('the navigation bar stays compact', async ({ page }) => {
    await loginAs(page, 'dev');
    await page.goto('/');
    const nav = await page.getByRole('navigation', { name: 'Main' }).boundingBox();
    expect(nav!.height).toBeLessThan(80);
    await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeInViewport();
  });

  test('the workspace switches between Files, Code, Claude and Changes', async ({ page }) => {
    await loginAs(page, 'dev');
    await openWorkspace(page);
    const tabs = page.getByRole('navigation', { name: 'Workspace' });
    for (const name of ['Files', 'Code', 'Claude']) await expect(tabs.getByRole('button', { name })).toBeVisible();
    await expect(tabs.getByRole('button', { name: /Changes/ })).toBeVisible();

    // Claude is the first panel on a phone.
    await expect(page.locator('.chat textarea')).toBeVisible();

    await tabs.getByRole('button', { name: 'Files' }).click();
    await page.getByRole('button', { name: 'README.md' }).click();
    // Opening a file jumps to the editor.
    await expect(page.locator('.monaco-editor').first()).toContainText('Payment Service');

    await tabs.getByRole('button', { name: /Changes/ }).click();
    await expect(page.getByPlaceholder('Commit message')).toBeVisible();
  });

  test('tap targets in the tab bar are large enough', async ({ page }) => {
    await loginAs(page, 'dev');
    await openWorkspace(page);
    const box = await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Files' }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test('chat works on a phone', async ({ page }) => {
    await loginAs(page, 'dev');
    await openWorkspace(page);
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.locator('.chat textarea').fill('Explain the retry logic');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.msg.plan')).toContainText('Raise MAX_RETRIES to 5');
  });
});
