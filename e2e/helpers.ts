import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'e2e-password-123';
export const ADMIN = 'admin@e2e.test';
export const DEV = 'dev@e2e.test';
export const API = 'http://127.0.0.1:4100';

export const stateFile = (who: 'admin' | 'dev') => path.join(__dirname, '.auth', `${who}.json`);

/** Signs in through the login form. */
export async function login(page: Page, email: string, password = PASSWORD) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
}

/** Reuses the session saved by auth.setup.ts. */
export async function loginAs(page: Page, who: 'admin' | 'dev') {
  const state = JSON.parse(readFileSync(stateFile(who), 'utf8')) as { cookies: Parameters<ReturnType<Page['context']>['addCookies']>[0] };
  await page.context().clearCookies();
  await page.context().addCookies(state.cookies);
  await page.goto('/clients');
  await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();
}

/** From the clients list down to the Payment Service application page. */
export async function openPaymentService(page: Page) {
  await page.getByRole('link', { name: 'ABC Technologies' }).click();
  await page.getByRole('link', { name: 'Payment Service' }).click();
  await expect(page.getByRole('heading', { name: /Payment Service/ })).toBeVisible();
}

/** Opens the developer's feature/retry workspace from the application page. */
export async function openWorkspace(page: Page) {
  await openPaymentService(page);
  await page.getByRole('link', { name: 'feature/retry' }).click();
  await expect(page.getByText('ABC Technologies / Payment Service')).toBeVisible();
}
