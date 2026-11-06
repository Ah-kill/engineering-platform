import { expect, test } from '@playwright/test';
import { loginAs, openPaymentService, openWorkspace } from './helpers';

const SECRET = 'sk_live_e2e_' + 'q'.repeat(20) + 'END9';

test.describe('environment variables and network access', () => {
  test('an admin adds a plain variable and a secret; the secret is never shown again', async ({ page }) => {
    await loginAs(page, 'admin');
    await openPaymentService(page);
    const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Environment variables' }) });
    await card.getByRole('tab', { name: 'development' }).click();

    await card.getByRole('button', { name: 'Add variable' }).click();
    await card.getByLabel('Name').fill('API_BASE_URL');
    await card.getByLabel('Secret: encrypted').uncheck();
    await card.getByLabel('Value', { exact: true }).fill('https://api.example.com');
    await card.getByLabel('Description (optional)').fill('Partner API');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByRole('row', { name: /API_BASE_URL/ })).toContainText('https://api.example.com');

    await card.getByRole('button', { name: 'Add variable' }).click();
    await card.getByLabel('Name').fill('payment secret'); // normalised to PAYMENT_SECRET
    await expect(card.getByLabel('Name')).toHaveValue('PAYMENT_SECRET');
    await card.getByLabel('Value', { exact: true }).fill(SECRET);
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByRole('row', { name: /PAYMENT_SECRET/ })).toContainText('secret …END9');

    await page.reload();
    expect(await page.content()).not.toContain(SECRET);
  });

  test('a .env file can be imported and a variable deleted', async ({ page }) => {
    await loginAs(page, 'admin');
    await openPaymentService(page);
    const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Environment variables' }) });
    await card.getByRole('button', { name: 'Import .env' }).click();
    await card.getByLabel('Paste the contents of a .env file').fill('WEBHOOK_TOKEN=abc123xyz789\nREGION=eu-west-1');
    await card.getByRole('button', { name: 'Import' }).click();
    await expect(card.getByRole('row', { name: /WEBHOOK_TOKEN/ })).toBeVisible();
    await expect(card.getByRole('row', { name: /REGION/ })).toContainText('secret');

    page.once('dialog', (d) => void d.accept());
    await card.getByRole('button', { name: 'Delete REGION' }).click();
    await expect(card.getByRole('row', { name: /REGION/ })).toHaveCount(0);
  });

  test('a developer can see names but not change them, and not secrets', async ({ page }) => {
    await loginAs(page, 'dev');
    await openPaymentService(page);
    const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Environment variables' }) });
    await expect(card.getByRole('row', { name: /PAYMENT_SECRET/ })).toContainText('secret');
    await expect(card.getByRole('button', { name: 'Add variable' })).toHaveCount(0);
    expect(await page.content()).not.toContain(SECRET);
  });

  test('Claude gets the variables by name and secrets are redacted in the chat', async ({ page }) => {
    await loginAs(page, 'dev');
    await openWorkspace(page);
    const chat = page.locator('.chat');
    await chat.getByRole('button', { name: 'New', exact: true }).click();
    await chat.getByRole('textbox').fill('Which environment variables do you have?');
    await chat.getByRole('button', { name: 'Send' }).click();
    await expect(chat.getByText(/Variables I can use: .*API_BASE_URL.*PAYMENT_SECRET/)).toBeVisible();
    await expect(chat.getByText('PAYMENT_SECRET is [redacted]')).toBeVisible();
    expect(await page.content()).not.toContain(SECRET);
  });

  test('network access: allow hosts and validate entries', async ({ page }) => {
    await loginAs(page, 'admin');
    await openPaymentService(page);
    const card = page.locator('form.card', { has: page.getByRole('heading', { name: 'Network access' }) });
    await expect(card.getByLabel('Only allowed sites')).toBeChecked();
    await expect(card.getByText('api.anthropic.com')).toBeVisible();

    const hosts = card.getByLabel(/Also allow/);
    await hosts.fill('https://not-a-host');
    await card.getByRole('button', { name: 'Save network access' }).click();
    await expect(card.getByText(/Not a host name/)).toBeVisible();

    await hosts.fill('api.example.com\n*.example.org');
    await card.getByRole('button', { name: 'Save network access' }).click();
    await expect(card.getByText(/Saved\. Takes effect/)).toBeVisible();
    await page.reload();
    await expect(page.getByLabel(/Also allow/)).toHaveValue('api.example.com\n*.example.org');
  });
});
