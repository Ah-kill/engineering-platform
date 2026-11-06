import { expect, test } from '@playwright/test';
import { loginAs } from './helpers';

const API_KEY = `sk-ant-api03-${'e2e'.repeat(15)}WXYZ`;

test.describe('Claude and GitHub settings', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, 'dev');
    await page.getByRole('link', { name: 'Claude & GitHub' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('rejects a value in the wrong format', async ({ page }) => {
    await page.getByLabel('Anthropic API key').fill('sk-ant-oat01-thisIsASubscriptionTokenNotAKey');
    await page.getByRole('button', { name: 'Save' }).first().click();
    await expect(page.getByText('Anthropic API keys start with "sk-ant-api"')).toBeVisible();
  });

  test('saves an API key and only shows its last characters', async ({ page }) => {
    await page.getByLabel('Anthropic API key').fill(API_KEY);
    await page.getByRole('button', { name: 'Save' }).first().click();
    await expect(page.getByText('Saved …WXYZ')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Saved …WXYZ')).toBeVisible();
    expect(await page.content()).not.toContain(API_KEY);
  });

  test('subscription mode explains claude setup-token', async ({ page }) => {
    await page.getByRole('radio', { name: 'Claude subscription' }).click();
    await expect(page.getByLabel('Claude subscription token')).toBeVisible();
    await expect(page.getByText('claude setup-token')).toBeVisible();
    await page.getByRole('radio', { name: 'API key' }).click();
    await expect(page.getByText('Saved …WXYZ')).toBeVisible();
  });

  test('lists models live from Claude Code and saves a choice', async ({ page }) => {
    test.slow(); // starts the bundled Claude Code to ask for its model list
    const sonnet = page.locator('.model-option', { hasText: 'Sonnet' });
    await expect(sonnet).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.model-option', { hasText: /Default/ })).toBeVisible();
    // The radio is controlled by the saved setting, so click and wait for the save to land.
    await sonnet.locator('input[type=radio]').click();
    await expect(page.locator('.model-option.on', { hasText: 'Sonnet' })).toBeVisible();
    await page.reload();
    await expect(page.locator('.model-option.on', { hasText: 'Sonnet' })).toBeVisible({ timeout: 60_000 });
    // Back to the default so later tests are not affected.
    await page.locator('.model-option', { hasText: /Default/ }).locator('input[type=radio]').click();
    await expect(page.locator('.model-option.on', { hasText: /Default/ })).toBeVisible();
  });
});
