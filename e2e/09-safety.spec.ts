import { expect, test } from '@playwright/test';
import { loginAs, openPaymentService, openWorkspace } from './helpers';

/**
 * Claude safety and operations: project instructions written by an admin reach Claude,
 * high-risk commands wait for approval with the reason shown, and admins can read the
 * team's conversations read-only. The agent is the scripted stand-in.
 */
const INSTRUCTIONS = 'Amounts are integers in cents. Use pnpm.';

test.describe('Claude safety and operations', () => {
  test('an admin writes project instructions; developers see them read-only', async ({ page }) => {
    await loginAs(page, 'admin');
    await openPaymentService(page);
    const card = page.getByRole('form', { name: 'Project instructions for Claude' });
    await card.getByLabel('Instructions').fill(INSTRUCTIONS);
    await card.getByRole('button', { name: 'Save instructions' }).click();
    await expect(card.getByText('Saved. Applies from the next Claude run.')).toBeVisible();

    await loginAs(page, 'dev');
    await openPaymentService(page);
    const readOnly = page.getByRole('form', { name: 'Project instructions for Claude' });
    await expect(readOnly).toContainText(INSTRUCTIONS);
    await expect(readOnly.getByRole('button', { name: 'Save instructions' })).toHaveCount(0);
    // Developers do not see the team's activity.
    await expect(page.getByRole('heading', { name: 'Team activity' })).toHaveCount(0);
  });

  test('Claude receives the project instructions', async ({ page }) => {
    await loginAs(page, 'dev');
    await openWorkspace(page);
    const chat = page.locator('.chat');
    await chat.getByRole('button', { name: 'New', exact: true }).click();
    await chat.getByRole('textbox').fill('What are the project instructions?');
    await chat.getByRole('button', { name: 'Send' }).click();
    await expect(chat.getByText(`Project instructions: ${INSTRUCTIONS}`)).toBeVisible();
  });

  test('a deploy waits for approval and says why', async ({ page }) => {
    await loginAs(page, 'dev');
    await openWorkspace(page);
    const chat = page.locator('.chat');
    await chat.getByRole('button', { name: 'New', exact: true }).click();
    await chat.getByRole('radio', { name: 'Execute' }).click();
    await chat.getByRole('textbox').fill('deploy the infrastructure');
    await chat.getByRole('button', { name: 'Send' }).click();

    const approval = chat.locator('.msg.approval').last();
    await expect(approval).toContainText('terraform -chdir=infra apply');
    await expect(approval).toContainText('Approval needed: Infrastructure change (terraform)');
    await approval.getByRole('button', { name: 'Reject' }).click();
    await expect(chat.getByText('Did not deploy.')).toBeVisible();
  });

  test('an admin reads the team activity and a transcript, read-only', async ({ page }) => {
    await loginAs(page, 'admin');
    await openPaymentService(page);
    const card = page.locator('[aria-label="Team activity"]');
    await expect(card.getByRole('heading', { name: 'Team activity' })).toBeVisible();
    const row = card.getByRole('row', { name: /deploy the infrastructure/ });
    await expect(row).toContainText('feature/retry');
    await expect(row).toContainText('Dev Dana');
    await row.getByRole('button', { name: 'View' }).click();

    const transcript = card.getByRole('region', { name: 'Transcript' });
    await expect(transcript).toContainText('deploy the infrastructure');
    await expect(transcript.locator('.msg.approval')).toContainText('Infrastructure change (terraform)');
    await expect(transcript).toContainText('Rejected');
    await expect(transcript.getByRole('button', { name: 'Allow' })).toHaveCount(0);
    await transcript.getByRole('button', { name: 'Close' }).click();
    await expect(transcript).toHaveCount(0);
  });
});
