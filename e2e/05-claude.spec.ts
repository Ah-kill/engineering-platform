import { expect, test } from '@playwright/test';
import { loginAs, openWorkspace } from './helpers';

/**
 * The agent here is the scripted stand-in (apps/api/e2e/scripted-driver.ts); everything
 * around it (streaming, plan capture, approvals, persistence, cost) is the real code.
 */
test.describe('working with Claude', () => {
  test('plan first, then approve and execute', async ({ page }) => {
    await loginAs(page, 'dev');
    await openWorkspace(page);

    const chat = page.locator('.chat');
    await expect(chat.getByRole('radio', { name: 'Plan' })).toHaveAttribute('aria-checked', 'true');
    await chat.getByRole('textbox').fill('Refactor the retry mechanism');
    await chat.getByRole('button', { name: 'Send' }).click();

    await expect(chat.getByText('Let me look at how retries work.')).toBeVisible();
    await expect(chat.locator('.tool').first()).toContainText('Read');
    const plan = chat.locator('.msg.plan');
    await expect(plan).toContainText('Raise MAX_RETRIES to 5');

    await plan.getByRole('button', { name: 'Approve and execute' }).click();
    await expect(chat.getByText('I raised MAX_RETRIES to 5.')).toBeVisible();
    await expect(chat.locator('.note', { hasText: 'Done' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Changes (1)' })).toBeVisible();
    await expect(chat.locator('.chat-cost')).toHaveText(/\$0\.0\d\d/);
  });

  test('destructive commands wait for approval', async ({ page }) => {
    await loginAs(page, 'dev');
    await openWorkspace(page);
    const chat = page.locator('.chat');
    // Start a separate conversation (the chat otherwise continues the selected one).
    await chat.getByRole('button', { name: 'New', exact: true }).click();
    await chat.getByRole('radio', { name: 'Execute' }).click();
    await chat.getByRole('textbox').fill('clean the build and retry');
    await chat.getByRole('button', { name: 'Send' }).click();

    const approval = chat.locator('.msg.approval').last();
    await expect(approval).toContainText('rm -rf build');
    await expect(chat.getByRole('button', { name: 'Stop' })).toBeVisible();
    await approval.getByRole('button', { name: 'Allow' }).click();
    await expect(chat.getByText('Cleaned the build folder.')).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Send' })).toBeVisible();
  });

  test('conversations are kept and can be reopened', async ({ page }) => {
    await loginAs(page, 'dev');
    await openWorkspace(page);
    const picker = page.getByLabel('Conversation', { exact: true });
    const titles = await picker.locator('option').allTextContents();
    expect(titles).toEqual(expect.arrayContaining(['Refactor the retry mechanism', 'clean the build and retry']));
    await picker.selectOption({ label: 'Refactor the retry mechanism' });
    await expect(page.locator('.msg.plan')).toContainText('Raise MAX_RETRIES to 5');
  });

  test('Claude changes show up in the editor and diff', async ({ page }) => {
    await loginAs(page, 'dev');
    await openWorkspace(page);
    await page.getByRole('tab', { name: 'Changes (1)' }).click();
    await page.getByRole('button', { name: /src\/retry\.js/ }).first().click();
    await expect(page.locator('.monaco-diff-editor')).toContainText('MAX_RETRIES = 5');
  });
});
