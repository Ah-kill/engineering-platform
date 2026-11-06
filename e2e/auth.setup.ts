import { test as setup } from '@playwright/test';
import { ADMIN, DEV, login, stateFile } from './helpers';

// Sign in once per user and reuse the session in every test. Signing in per test would
// trip the app's login rate limit (10 per minute), which is the intended behaviour.
for (const [who, email] of [['admin', ADMIN], ['dev', DEV]] as const) {
  setup(`sign in as ${who}`, async ({ page }) => {
    await login(page, email);
    await page.context().storageState({ path: stateFile(who) });
  });
}
