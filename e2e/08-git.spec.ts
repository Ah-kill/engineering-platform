import { expect, test, type Page } from '@playwright/test';
import { loginAs, openPaymentService } from './helpers';

/**
 * History, compare, branch deletion, reset, code search and sharing in the IDE. Runs in its
 * own workspace so the destructive steps never touch feature/retry, which later specs use.
 * GitHub's REST API is unreachable in the e2e stack, so pull requests, the repository picker
 * and branch protection are covered by the API tests instead.
 */

const BRANCH = 'feature/git-tools';

async function openToolsWorkspace(page: Page) {
  await openPaymentService(page);
  await page.getByRole('link', { name: BRANCH }).click();
  await expect(page.getByText('ABC Technologies / Payment Service')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ide-branch code')).toHaveText(BRANCH);
}

/** Writes a file through the API with the page's session (same CSRF header as the app). */
async function writeFile(page: Page, path: string, content: string) {
  const id = new URL(page.url()).pathname.split('/').pop()!;
  const res = await page.request.put(`/api/workspaces/${id}/file`, {
    headers: { 'x-requested-with': 'platform-web' },
    data: { path, content },
  });
  expect(res.ok()).toBe(true);
}

test.describe('git tools in the workspace', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => void d.accept());
  });

  test('creates a workspace for these tests and commits a change', async ({ page }) => {
    await loginAs(page, 'dev');
    await openPaymentService(page);
    await page.getByRole('button', { name: 'New workspace' }).click();
    await page.getByLabel('New branch name').fill(BRANCH);
    await page.getByRole('button', { name: 'Create and open' }).click();
    await expect(page.locator('.ide-branch code')).toHaveText(BRANCH, { timeout: 30_000 });

    await writeFile(page, 'src/limits.js', 'export const LIMIT = 10;\n');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.getByRole('tab', { name: /Changes \(1\)/ }).click();
    await page.getByPlaceholder('Commit message').fill('Add limits');
    await page.getByRole('button', { name: 'Commit all changes' }).click();
    await expect(page.getByText('No changes.')).toBeVisible();
  });

  test('history lists commits and shows a commit’s files and diff', async ({ page }) => {
    await loginAs(page, 'dev');
    await openToolsWorkspace(page);
    await page.getByRole('tab', { name: /Changes/ }).click();
    await page.getByText('History', { exact: true }).click();
    await page.getByRole('button', { name: /Add limits/ }).click();

    const review = page.getByRole('dialog', { name: 'Add limits' });
    await expect(review).toBeVisible();
    await expect(review.getByRole('button', { name: /src\/limits\.js/ })).toBeVisible();
    await expect(review.locator('.monaco-diff-editor')).toBeVisible();
    await review.getByRole('button', { name: 'Close review' }).click();
    await expect(review).toHaveCount(0);
  });

  test('compares the branch with main', async ({ page }) => {
    await loginAs(page, 'dev');
    await openToolsWorkspace(page);
    await page.getByRole('tab', { name: /Changes/ }).click();
    await page.getByText('Compare branches', { exact: true }).click();
    await page.getByRole('combobox', { name: /^Base/ }).selectOption('main');
    await page.getByRole('combobox', { name: /^Compare/ }).selectOption(BRANCH);
    await page.getByRole('button', { name: 'Compare', exact: true }).click();

    const review = page.getByRole('dialog', { name: `${BRANCH} compared with main` });
    await expect(review).toBeVisible();
    await expect(review.getByText('1 commit')).toBeVisible();
    await expect(review.getByRole('button', { name: /src\/limits\.js/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(review).toHaveCount(0);
  });

  test('code search finds a line and opens the file there', async ({ page }) => {
    await loginAs(page, 'dev');
    await openToolsWorkspace(page);
    await page.getByRole('tab', { name: 'Search' }).click();
    await page.getByLabel('Search code').fill('LIMIT =');
    await page.getByLabel('Search code').press('Enter');
    const results = page.getByRole('list', { name: 'Search results' });
    await expect(results.getByText('src/limits.js')).toBeVisible();
    await results.getByRole('button', { name: /export const LIMIT = 10/ }).click();
    await expect(page.locator('.tab.active')).toContainText('limits.js');
    await expect(page.locator('.monaco-editor').first()).toContainText('LIMIT = 10');

    await page.getByLabel('Search code').fill('(unclosed');
    await page.getByLabel('Regular expression').check();
    await page.getByLabel('Search code').press('Enter');
    await expect(page.getByText(/Invalid search/)).toBeVisible();
  });

  test('deletes a local branch but never the current one', async ({ page }) => {
    await loginAs(page, 'dev');
    await openToolsWorkspace(page);
    await page.getByRole('tab', { name: /Changes/ }).click();
    await page.getByText('Branches', { exact: true }).click();
    await page.getByLabel('New branch from here').fill('feature/throwaway-branch');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('.ide-branch code')).toHaveText('feature/throwaway-branch');
    await page.getByRole('button', { name: BRANCH }).click();
    await expect(page.locator('.ide-branch code')).toHaveText(BRANCH);

    const row = page.locator('.branches li', { has: page.getByRole('button', { name: 'feature/throwaway-branch' }) });
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('button', { name: 'feature/throwaway-branch' })).toHaveCount(0);
    // The current branch offers no delete button.
    const current = page.locator('.branches li', { has: page.getByRole('button', { name: BRANCH }) });
    await expect(current.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  });

  test('reset discards every uncommitted change after confirming', async ({ page }) => {
    await loginAs(page, 'dev');
    await openToolsWorkspace(page);
    await writeFile(page, 'src/limits.js', 'broken\n');
    await writeFile(page, 'scratch/notes.txt', 'temporary\n');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.getByRole('tab', { name: 'Changes (2)' }).click();
    await page.getByText('Reset workspace', { exact: true }).click();
    await page.getByRole('button', { name: 'Discard all changes' }).click();
    await expect(page.getByText('No changes.')).toBeVisible();
    await expect(page.getByText('Reset: done')).toBeVisible();
  });

  test('pull requests explain that a GitHub token is needed', async ({ page }) => {
    await loginAs(page, 'dev');
    await openToolsWorkspace(page);
    await page.getByRole('tab', { name: /Changes/ }).click();
    await page.getByText('Pull requests', { exact: true }).click();
    await expect(page.getByText(/Add a GitHub token for acme/)).toBeVisible();
  });

  test('the owner opens the share dialog', async ({ page }) => {
    await loginAs(page, 'dev');
    await openToolsWorkspace(page);
    await page.getByRole('button', { name: 'Share' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share workspace' });
    await expect(dialog.getByText('owner', { exact: true })).toBeVisible();
    // The only other user is an org admin, who has no working access to the environment.
    await expect(dialog.getByText(/Nobody else has working access/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 412, height: 839 }, hasTouch: true });

    test('code search lives in the Files tab', async ({ page }) => {
      await loginAs(page, 'dev');
      await openToolsWorkspace(page);
      const tabs = page.getByRole('navigation', { name: 'Workspace' });
      await tabs.getByRole('button', { name: 'Files' }).click();
      await page.getByRole('radio', { name: 'Search code' }).click();
      await page.getByLabel('Search code').fill('LIMIT');
      await page.getByLabel('Search code').press('Enter');
      await page.getByRole('list', { name: 'Search results' }).getByRole('button', { name: /LIMIT = 10/ }).click();
      await expect(page.locator('.monaco-editor').first()).toContainText('LIMIT = 10');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });
  });

  test('removes the test workspace', async ({ page }) => {
    await loginAs(page, 'dev');
    await openPaymentService(page);
    await page.getByRole('button', { name: `Delete workspace ${BRANCH}` }).click();
    await expect(page.getByRole('link', { name: BRANCH })).toHaveCount(0);
  });
});
