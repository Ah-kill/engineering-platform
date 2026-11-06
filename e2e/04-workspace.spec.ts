import { expect, test } from '@playwright/test';
import { API, loginAs, openPaymentService, openWorkspace } from './helpers';

test.describe('workspace, editor and git', () => {
  test('production cannot be chosen for a workspace without explicit access', async ({ page }) => {
    await loginAs(page, 'dev');
    await openPaymentService(page);
    await page.getByRole('button', { name: 'New workspace' }).click();
    const options = await page.getByRole('combobox', { name: /^Environment/ }).locator('option').allTextContents();
    expect(options.join(' ')).toContain('development');
    expect(options.join(' ')).not.toContain('production');
  });

  test('creates a workspace on a new branch and opens the IDE', async ({ page }) => {
    await loginAs(page, 'dev');
    await openPaymentService(page);
    await page.getByRole('button', { name: 'New workspace' }).click();
    await page.getByLabel('New branch name').fill('feature/retry');
    await page.getByRole('button', { name: 'Create and open' }).click();

    await expect(page.getByText('ABC Technologies / Payment Service')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.ide-branch code')).toHaveText('feature/retry');
    await expect(page.getByRole('button', { name: 'README.md' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'src' })).toBeVisible();
  });

  test('opens a file in the editor, edits it and saves with Ctrl+S', async ({ page }) => {
    await loginAs(page, 'dev');
    await openWorkspace(page);
    await page.getByRole('button', { name: 'src' }).click();
    await page.getByRole('button', { name: 'retry.js' }).click();
    const editor = page.locator('.monaco-editor').first();
    await expect(editor).toContainText('MAX_RETRIES = 3');

    await editor.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('export const MAX_RETRIES = 4;');
    await expect(page.locator('.tab .dot')).toBeVisible(); // unsaved marker
    await page.keyboard.press('ControlOrMeta+S');
    await expect(page.getByText('Saved src/retry.js')).toBeVisible();
    await expect(page.locator('.tab .dot')).toHaveCount(0);
  });

  test('file search filters the tree', async ({ page }) => {
    await loginAs(page, 'dev');
    await openWorkspace(page);
    await page.getByLabel('Search files').fill('retry');
    await expect(page.getByRole('button', { name: 'src/retry.js' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'README.md' })).toHaveCount(0);
  });

  test('shows the change, its diff, commits and pushes the branch', async ({ page, request }) => {
    await loginAs(page, 'dev');
    await openWorkspace(page);
    await page.getByRole('tab', { name: 'Changes (1)' }).click();
    await page.getByRole('button', { name: /src\/retry\.js/ }).first().click();
    await expect(page.locator('.monaco-diff-editor')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();

    await page.getByPlaceholder('Commit message').fill('Raise retries to 4');
    await page.getByRole('button', { name: 'Commit all changes' }).click();
    await expect(page.getByText('No changes.')).toBeVisible();
    await expect(page.getByText('1 to push')).toBeVisible();

    await page.getByRole('button', { name: 'Push', exact: true }).click();
    await expect(page.getByText('Push: done')).toBeVisible();
    const branches = await (await request.get(`${API}/e2e/remote-branches`)).json();
    expect(branches).toContain('feature/retry');
  });

  test('creates and switches branches from the UI', async ({ page }) => {
    await loginAs(page, 'dev');
    await openWorkspace(page);
    await page.getByRole('tab', { name: /Changes/ }).click();
    await page.getByText('Branches', { exact: true }).click();
    await page.getByLabel('New branch from here').fill('feature/refund-api');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('.ide-branch code')).toHaveText('feature/refund-api');
    await page.getByRole('button', { name: 'feature/retry' }).click();
    await expect(page.locator('.ide-branch code')).toHaveText('feature/retry');
  });
});
