import { expect, test } from '@playwright/test';
import { loginAs, openPaymentService } from './helpers';

test.describe('admin onboards a client', () => {
  test('a new developer starts with no access', async ({ page }) => {
    await loginAs(page, 'dev');
    await expect(page.getByText('You have not been given access to any client yet')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Developers' })).toHaveCount(0);
  });

  test('creates a client and an application with default environments', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.getByRole('button', { name: 'New client' }).click();
    await page.getByLabel('Name').fill('ABC Technologies');
    await page.getByLabel('Description').fill('Fintech client');
    await page.getByRole('button', { name: 'Create client' }).click();
    await expect(page.getByRole('heading', { name: 'ABC Technologies' })).toBeVisible();

    await page.getByRole('button', { name: 'New application' }).click();
    await page.getByLabel('Name').fill('Payment Service');
    await page.getByRole('button', { name: 'Create application' }).click();
    await expect(page.getByRole('heading', { name: /Payment Service/ })).toBeVisible();

    const envs = page.locator('table').first();
    await expect(envs.getByRole('row', { name: /^development/ })).toBeVisible();
    await expect(envs.getByRole('row', { name: /^staging/ })).toBeVisible();
    const prod = envs.getByRole('row', { name: /production/ });
    await expect(prod.getByText('protected')).toBeVisible();
  });

  test('connects the GitHub repository', async ({ page }) => {
    await loginAs(page, 'admin');
    await openPaymentService(page);
    await page.getByRole('button', { name: 'Connect GitHub repository' }).click();
    await page.getByLabel('GitHub URL').fill('https://evil.example.com/acme/payments');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Use a GitHub repository URL/)).toBeVisible();

    await page.getByLabel('GitHub URL').fill('https://github.com/acme/payments');
    await page.getByLabel('Default branch').fill('main');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('link', { name: 'acme/payments' })).toBeVisible();
  });

  test('grants the developer access to the application', async ({ page }) => {
    await loginAs(page, 'admin');
    await openPaymentService(page);
    // A select's accessible name includes its current option, so match the start of the label.
    await page.getByRole('combobox', { name: /^Developer/ }).selectOption({ label: 'Dev Dana (dev@e2e.test)' });
    await page.getByRole('combobox', { name: /^Role/ }).selectOption('developer');
    await page.getByRole('button', { name: 'Grant access' }).click();
    await expect(page.getByRole('row', { name: /Dev Dana/ }).getByRole('cell', { name: 'Developer' })).toBeVisible();
  });

  test('the developer now sees only that application, and production stays view-only', async ({ page }) => {
    await loginAs(page, 'dev');
    await openPaymentService(page);
    const envs = page.locator('table').first();
    await expect(envs.getByRole('row', { name: /development/ }).getByText('can work here')).toBeVisible();
    await expect(envs.getByRole('row', { name: /production/ }).getByText('view only')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  });

  test('the change history is in the audit log', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.getByRole('link', { name: 'Audit log' }).click();
    for (const action of ['client.created', 'application.created', 'repository.connected', 'grant.created']) {
      await expect(page.getByRole('cell', { name: action, exact: true }).first()).toBeVisible();
    }
  });
});
