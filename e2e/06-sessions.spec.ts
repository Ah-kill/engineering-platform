import { expect, test } from '@playwright/test';
import { loginAs, openPaymentService } from './helpers';

test.describe('picking up where you left off', () => {
  test('home shows recent workspaces with their latest conversation', async ({ page }) => {
    await loginAs(page, 'dev');
    await page.getByRole('link', { name: 'Home' }).click();
    await expect(page.getByRole('heading', { name: 'Continue where you left off' })).toBeVisible();
    const card = page.locator('.recent-card', { hasText: 'feature/retry' });
    await expect(card).toContainText('ABC Technologies / Payment Service');
    await expect(card).toContainText('clean the build and retry');
    await expect(card).toContainText('conversations');
  });

  test('Resume opens the workspace on that conversation', async ({ page }) => {
    await loginAs(page, 'dev');
    await page.goto('/');
    await page.locator('.recent-card', { hasText: 'feature/retry' }).click();
    await expect(page.getByLabel('Conversation', { exact: true })).toHaveValue(/.+/);
    await expect(page.locator('.chat .msg.user').first()).toContainText('clean the build and retry');
  });

  test('a conversation can be deleted', async ({ page }) => {
    await loginAs(page, 'dev');
    await page.goto('/');
    await page.locator('.recent-card', { hasText: 'feature/retry' }).click();
    const picker = page.getByLabel('Conversation', { exact: true });
    await picker.selectOption({ label: 'clean the build and retry' });
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Delete conversation' }).click();
    await expect(picker.locator('option', { hasText: 'clean the build and retry' })).toHaveCount(0);
    await expect(picker.locator('option', { hasText: 'Refactor the retry mechanism' })).toHaveCount(1);
  });

  test('a workspace can be deleted from the application page', async ({ page }) => {
    await loginAs(page, 'dev');
    await openPaymentService(page);
    await page.getByRole('button', { name: 'New workspace' }).click();
    await page.getByLabel('New branch name').fill('feature/throwaway');
    await page.getByRole('button', { name: 'Create and open' }).click();
    await expect(page.locator('.ide-branch code')).toHaveText('feature/throwaway', { timeout: 30_000 });

    await page.getByRole('link', { name: 'Back to application' }).click();
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Delete workspace feature/throwaway' }).click();
    await expect(page.getByRole('link', { name: 'feature/throwaway' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'feature/retry' })).toBeVisible();
  });
});
