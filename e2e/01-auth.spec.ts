import { expect, test } from '@playwright/test';
import { ADMIN, login } from './helpers';

test.describe('sign in', () => {
  test('rejects a wrong password without saying which part was wrong', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Email').fill(ADMIN);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Invalid email or password');
  });

  test('signs in, shows the organisation, and signs out', async ({ page }) => {
    await login(page, ADMIN);
    await expect(page.getByText('E2E Co')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Developers' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('the session cookie is not readable from JavaScript', async ({ page }) => {
    await login(page, ADMIN);
    expect(await page.evaluate(() => document.cookie)).not.toContain('ep_session');
  });
});
