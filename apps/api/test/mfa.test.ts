import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUrl,
  totpCode,
  totpStep,
  verifyTotp,
  type TotpAlgorithm,
} from '../src/identity/mfa-totp.js';
import { generateRecoveryCode, normalizeRecoveryCode } from '../src/identity/mfa.js';
import { Client, PASSWORD, seedOrg, setup, WEB_ORIGIN, type TestEnv } from './helpers.js';

describe('TOTP (RFC 6238)', () => {
  // Appendix B of RFC 6238: 8-digit codes, 30-second steps, ASCII seeds per algorithm.
  const seeds: Record<TotpAlgorithm, Buffer> = {
    sha1: Buffer.from('12345678901234567890'),
    sha256: Buffer.from('12345678901234567890123456789012'),
    sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
  };
  const vectors: [number, Record<TotpAlgorithm, string>][] = [
    [59, { sha1: '94287082', sha256: '46119246', sha512: '90693936' }],
    [1111111109, { sha1: '07081804', sha256: '68084774', sha512: '25091201' }],
    [1111111111, { sha1: '14050471', sha256: '67062674', sha512: '99943326' }],
    [1234567890, { sha1: '89005924', sha256: '91819424', sha512: '93441116' }],
    [2000000000, { sha1: '69279037', sha256: '90698825', sha512: '38618901' }],
    [20000000000, { sha1: '65353130', sha256: '77737706', sha512: '47863826' }],
  ];

  it('matches the RFC 6238 test vectors', () => {
    for (const [time, expected] of vectors) {
      for (const alg of ['sha1', 'sha256', 'sha512'] as const) {
        expect(hotp(seeds[alg], totpStep(time * 1000), 8, alg), `${alg} @ ${time}`).toBe(expected[alg]);
      }
    }
  });

  it('produces the 6-digit SHA-1 codes authenticator apps show for a base32 secret', () => {
    const secret = base32Encode(seeds.sha1);
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    for (const [time, expected] of vectors) expect(totpCode(secret, time * 1000)).toBe(expected.sha1.slice(-6));
  });

  it('encodes and decodes base32 (RFC 4648)', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw 6ytb oi').toString()).toBe('foobar');
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it('accepts one step either side, never older steps than the last one used', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const at = (d: number) => totpCode(secret, now + d * 30_000);
    expect(verifyTotp(secret, at(0), { nowMs: now })).toBe(step);
    expect(verifyTotp(secret, at(-1), { nowMs: now })).toBe(step - 1);
    expect(verifyTotp(secret, at(1), { nowMs: now })).toBe(step + 1);
    expect(verifyTotp(secret, at(-2), { nowMs: now })).toBeNull();
    expect(verifyTotp(secret, at(2), { nowMs: now })).toBeNull();
    // Replay: the step already used, and anything before it, is refused.
    expect(verifyTotp(secret, at(0), { nowMs: now, lastStep: step })).toBeNull();
    expect(verifyTotp(secret, at(-1), { nowMs: now, lastStep: step })).toBeNull();
    expect(verifyTotp(secret, at(1), { nowMs: now, lastStep: step })).toBe(step + 1);
    expect(verifyTotp(secret, 'abcdef', { nowMs: now })).toBeNull();
    expect(verifyTotp(secret, '12345', { nowMs: now })).toBeNull();
  });

  it('builds an otpauth URL authenticator apps understand', () => {
    const url = otpauthUrl({ secret: 'ABC', issuer: 'Engineering Platform', account: 'dev@acme.test' });
    expect(url).toBe('otpauth://totp/Engineering%20Platform:dev%40acme.test?secret=ABC&issuer=Engineering%20Platform&algorithm=SHA1&digits=6&period=30');
  });

  it('makes high-entropy recovery codes and normalises what people type', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    expect(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, ' '))).toBe(code.replace(/-/g, ''));
    expect(normalizeRecoveryCode('123456')).toBeNull();
  });
});

// ---- through HTTP ---------------------------------------------------------

/**
 * A browser with its own IP (login routes are rate-limited per IP) and cookie jar.
 */
let nextIp = 1;
class Browser {
  readonly ip = `10.20.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`;
  cookie?: string;
  constructor(private readonly env: TestEnv) {}

  async request(method: InjectOptions['method'], url: string, payload?: unknown) {
    const headers: Record<string, string> = { origin: WEB_ORIGIN, 'x-requested-with': 'platform' };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await this.env.app.inject({
      method, url, headers, remoteAddress: this.ip,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (raw) this.cookie = raw.split(';')[0];
    seenResponses.push({ url, body: res.body });
    return res;
  }
  get(url: string) { return this.request('GET', url); }
  post(url: string, body: unknown = {}) { return this.request('POST', url, body); }
  patch(url: string, body: unknown) { return this.request('PATCH', url, body); }
}

/** Every response body, to check afterwards that no secret or code leaked outside setup/enable. */
const seenResponses: { url: string; body: string }[] = [];
/** Every secret and recovery code handed out, and every code typed. */
const secrets: string[] = [];

let env: TestEnv;
let admin: Client;
let orgId: string;

async function createUser(email: string): Promise<string> {
  const r = await admin.post('/api/users', { email, displayName: email.split('@')[0], password: PASSWORD });
  expect(r.statusCode).toBe(201);
  return r.json().id;
}

async function signInPasswordOnly(email: string): Promise<Browser> {
  const b = new Browser(env);
  const r = await b.post('/api/auth/login', { email, password: PASSWORD });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ ok: true });
  return b;
}

/** Turns two-step login on for a user; returns their signed-in browser, secret and recovery codes. */
async function enrol(email: string) {
  const b = await signInPasswordOnly(email);
  const setup = await b.post('/api/me/mfa/setup');
  expect(setup.statusCode).toBe(200);
  const { secret, otpauthUrl: url, qrDataUrl } = setup.json() as { secret: string; otpauthUrl: string; qrDataUrl: string };
  secrets.push(secret);
  expect(url).toContain(`secret=${secret}`);
  expect(url).toContain(encodeURIComponent(email));
  expect(qrDataUrl).toMatch(/^data:image\/png;base64,/);

  const code = totpCode(secret);
  const enable = await b.post('/api/me/mfa/enable', { code });
  expect(enable.statusCode).toBe(200);
  const { recoveryCodes } = enable.json() as { recoveryCodes: string[] };
  secrets.push(...recoveryCodes);
  expect(recoveryCodes).toHaveLength(10);
  expect(new Set(recoveryCodes).size).toBe(10);
  return { browser: b, secret, recoveryCodes, enableCode: code };
}

/** A 6-digit code that is not valid anywhere in the ±1 step window right now. */
function wrongCode(secret: string): string {
  const valid = new Set([-1, 0, 1].map((d) => totpCode(secret, Date.now() + d * 30_000)));
  for (let n = 0; ; n++) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

/** Lets the next sign-in use the current code again (tests that are not about replay). */
async function forgetLastStep(email: string) {
  await env.db.system((q) => q.query('UPDATE users SET totp_last_step = NULL WHERE email = $1', [email]));
}

async function passwordStep(email: string, b = new Browser(env)) {
  const r = await b.post('/api/auth/login', { email, password: PASSWORD });
  expect(r.statusCode).toBe(200);
  const body = r.json() as { mfaRequired?: boolean; challenge?: string };
  expect(body.mfaRequired).toBe(true);
  expect(r.headers['set-cookie']).toBeUndefined();
  expect(b.cookie).toBeUndefined();
  return { b, challenge: body.challenge! };
}

beforeAll(async () => {
  env = await setup();
  const seeded = await seedOrg(env.db, 'mfa');
  orgId = seeded.orgId;
  admin = await Client.login(env.app, seeded.adminEmail);
});

afterAll(async () => {
  await env.close();
});

describe('two-step login', () => {
  it('a user without two-step login signs in with the password alone', async () => {
    await createUser('plain@mfa.test');
    const b = await signInPasswordOnly('plain@mfa.test');
    expect((await b.get('/api/auth/me')).statusCode).toBe(200);
    expect((await b.get('/api/me/mfa')).json()).toEqual({ enabled: false, recoveryCodesLeft: 0 });
  });

  it('after enrolment, the password alone gives no session and a code is needed', async () => {
    await createUser('alice@mfa.test');
    const { browser, secret, enableCode } = await enrol('alice@mfa.test');
    expect((await browser.get('/api/me/mfa')).json()).toEqual({ enabled: true, recoveryCodesLeft: 10 });

    const { b, challenge } = await passwordStep('alice@mfa.test');
    expect(challenge.length).toBeGreaterThanOrEqual(40);
    expect((await b.get('/api/auth/me')).statusCode).toBe(401);
    // The challenge is stored only as a hash.
    const stored = await env.db.system((q) => q.query<{ token_hash: string }>('SELECT token_hash FROM mfa_challenges'));
    expect(stored.map((r) => r.token_hash)).not.toContain(challenge);

    // The code that confirmed enrolment has been used, so it cannot sign in.
    const replay = await b.post('/api/auth/login/mfa', { challenge, code: enableCode });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.message).toBe('Invalid code');

    // The next step's code (within the ±1 window) works and sets the session cookie.
    const code = totpCode(secret, Date.now() + 30_000);
    secrets.push(code);
    const ok = await b.post('/api/auth/login/mfa', { challenge, code });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers['set-cookie'])).toMatch(/ep_session=.*HttpOnly.*SameSite=Strict/i);
    const me = await b.get('/api/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('alice@mfa.test');

    // A finished challenge cannot be used again.
    const again = await b.post('/api/auth/login/mfa', { challenge, code });
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe('mfa_expired');
  });

  it('signs out other devices when two-step login is turned on', async () => {
    await createUser('devices@mfa.test');
    const other = await signInPasswordOnly('devices@mfa.test');
    const { browser } = await enrol('devices@mfa.test');
    expect((await other.get('/api/auth/me')).statusCode).toBe(401);
    expect((await browser.get('/api/auth/me')).statusCode).toBe(200);
  });

  it('rejects a wrong code, and the challenge dies after 5 attempts', async () => {
    await createUser('bob@mfa.test');
    const { secret } = await enrol('bob@mfa.test');
    await forgetLastStep('bob@mfa.test');
    const { b, challenge } = await passwordStep('bob@mfa.test');

    const right = totpCode(secret);
    const wrong = wrongCode(secret);
    for (let i = 0; i < 5; i++) {
      const r = await b.post('/api/auth/login/mfa', { challenge, code: wrong });
      expect(r.statusCode).toBe(401);
      expect(r.json().error.message).toBe('Invalid code');
    }
    const late = await b.post('/api/auth/login/mfa', { challenge, code: right });
    expect(late.statusCode).toBe(401);
    expect(late.json().error.code).toBe('mfa_expired');
    expect(b.cookie).toBeUndefined();

    const denied = await env.db.system((q) =>
      q.query(`SELECT 1 FROM audit_events ae JOIN users u ON u.id = ae.actor_id
                WHERE u.email = 'bob@mfa.test' AND ae.action = 'auth.mfa' AND ae.outcome = 'denied'`),
    );
    expect(denied).toHaveLength(5);

    // A fresh password step gives a fresh challenge.
    const next = await passwordStep('bob@mfa.test');
    expect((await next.b.post('/api/auth/login/mfa', { challenge: next.challenge, code: right })).statusCode).toBe(200);
  });

  it('pauses two-step sign-in after 10 wrong codes across sign-in attempts', async () => {
    await createUser('lock@mfa.test');
    const { secret } = await enrol('lock@mfa.test');
    await forgetLastStep('lock@mfa.test');
    const wrong = wrongCode(secret);
    // Spread over fresh challenges (each allows 5), so only the per-user limit can stop it.
    for (let round = 0; round < 2; round++) {
      const { b, challenge } = await passwordStep('lock@mfa.test');
      for (let i = 0; i < 5; i++) expect((await b.post('/api/auth/login/mfa', { challenge, code: wrong })).statusCode).toBe(401);
    }
    // Now locked: no new challenge, even with the right password.
    const r = await new Browser(env).post('/api/auth/login', { email: 'lock@mfa.test', password: PASSWORD });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('mfa_locked');
    // And after the pause ends, the right code works again.
    await env.db.system((q) => q.query("UPDATE users SET mfa_locked_until = now() - interval '1 second' WHERE email = $1", ['lock@mfa.test']));
    const { b, challenge } = await passwordStep('lock@mfa.test');
    expect((await b.post('/api/auth/login/mfa', { challenge, code: totpCode(secret) })).statusCode).toBe(200);
  });

  it('a challenge issued before the lock cannot be used while locked', async () => {
    await createUser('lock2@mfa.test');
    const { secret } = await enrol('lock2@mfa.test');
    await forgetLastStep('lock2@mfa.test');
    const { b, challenge } = await passwordStep('lock2@mfa.test');
    await env.db.system((q) => q.query("UPDATE users SET mfa_locked_until = now() + interval '10 minutes' WHERE email = $1", ['lock2@mfa.test']));
    const r = await b.post('/api/auth/login/mfa', { challenge, code: totpCode(secret) });
    expect(r.statusCode).toBe(429);
    expect(b.cookie).toBeUndefined();
  });

  it('rejects a replayed code', async () => {
    await createUser('carol@mfa.test');
    const { secret } = await enrol('carol@mfa.test');
    await forgetLastStep('carol@mfa.test');
    const code = totpCode(secret);
    secrets.push(code);

    const first = await passwordStep('carol@mfa.test');
    expect((await first.b.post('/api/auth/login/mfa', { challenge: first.challenge, code })).statusCode).toBe(200);

    const second = await passwordStep('carol@mfa.test');
    const replay = await second.b.post('/api/auth/login/mfa', { challenge: second.challenge, code });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.message).toBe('Invalid code');
  });

  it('accepts a recovery code exactly once', async () => {
    await createUser('dave@mfa.test');
    const { browser, recoveryCodes } = await enrol('dave@mfa.test');
    const code = recoveryCodes[0]!;

    // Any case, with spaces instead of dashes.
    const first = await passwordStep('dave@mfa.test');
    const typed = code.toLowerCase().replace(/-/g, ' ');
    expect((await first.b.post('/api/auth/login/mfa', { challenge: first.challenge, code: typed })).statusCode).toBe(200);
    expect((await browser.get('/api/me/mfa')).json()).toEqual({ enabled: true, recoveryCodesLeft: 9 });

    const second = await passwordStep('dave@mfa.test');
    expect((await second.b.post('/api/auth/login/mfa', { challenge: second.challenge, code })).statusCode).toBe(401);
    expect((await second.b.post('/api/auth/login/mfa', { challenge: second.challenge, code: recoveryCodes[1]! })).statusCode).toBe(200);

    // Recovery codes are stored only as hashes.
    const rows = await env.db.system((q) =>
      q.query<{ code_hash: string }>(
        `SELECT c.code_hash FROM mfa_recovery_codes c JOIN users u ON u.id = c.user_id WHERE u.email = 'dave@mfa.test'`,
      ),
    );
    expect(rows).toHaveLength(10);
    for (const r of rows) expect(r.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('regenerating recovery codes needs a code and replaces the old ones', async () => {
    await createUser('erin@mfa.test');
    const { browser, secret, recoveryCodes } = await enrol('erin@mfa.test');
    await forgetLastStep('erin@mfa.test');

    expect((await browser.post('/api/me/mfa/recovery-codes', { code: wrongCode(secret) })).statusCode).toBe(400);
    const r = await browser.post('/api/me/mfa/recovery-codes', { code: totpCode(secret) });
    expect(r.statusCode).toBe(200);
    const fresh = r.json().recoveryCodes as string[];
    secrets.push(...fresh);
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(recoveryCodes[0]);

    const old = await passwordStep('erin@mfa.test');
    expect((await old.b.post('/api/auth/login/mfa', { challenge: old.challenge, code: recoveryCodes[0]! })).statusCode).toBe(401);
    expect((await old.b.post('/api/auth/login/mfa', { challenge: old.challenge, code: fresh[0]! })).statusCode).toBe(200);
  });

  it('turning it off needs both the password and a code', async () => {
    await createUser('frank@mfa.test');
    const { browser, secret } = await enrol('frank@mfa.test');
    await forgetLastStep('frank@mfa.test');

    expect((await browser.post('/api/me/mfa/disable', { password: PASSWORD })).statusCode).toBe(400);
    const wrongPassword = await browser.post('/api/me/mfa/disable', { password: 'not-the-password', code: totpCode(secret) });
    expect(wrongPassword.statusCode).toBe(400);
    expect(wrongPassword.json().error.message).toBe('Password or code is incorrect');
    const badCode = await browser.post('/api/me/mfa/disable', { password: PASSWORD, code: wrongCode(secret) });
    expect(badCode.statusCode).toBe(400);
    expect((await browser.get('/api/me/mfa')).json().enabled).toBe(true);

    // The right code was not spent by the wrong-password attempt.
    const ok = await browser.post('/api/me/mfa/disable', { password: PASSWORD, code: totpCode(secret) });
    expect(ok.statusCode).toBe(200);
    expect((await browser.get('/api/me/mfa')).json()).toEqual({ enabled: false, recoveryCodesLeft: 0 });
    await signInPasswordOnly('frank@mfa.test');

    const [row] = await env.db.system((q) =>
      q.query<{ totp_secret: string | null; totp_pending_secret: string | null }>(
        `SELECT totp_secret, totp_pending_secret FROM users WHERE email = 'frank@mfa.test'`,
      ),
    );
    expect(row).toEqual({ totp_secret: null, totp_pending_secret: null });
  });

  it('enrolment needs a valid code from the pending secret', async () => {
    await createUser('gina@mfa.test');
    const b = await signInPasswordOnly('gina@mfa.test');
    expect((await b.post('/api/me/mfa/enable', { code: '123456' })).statusCode).toBe(400);
    const { secret } = (await b.post('/api/me/mfa/setup')).json() as { secret: string };
    secrets.push(secret);
    expect((await b.post('/api/me/mfa/enable', { code: wrongCode(secret) })).statusCode).toBe(400);
    expect((await b.get('/api/me/mfa')).json().enabled).toBe(false);
    // Still password-only until confirmed.
    await signInPasswordOnly('gina@mfa.test');
    // The pending secret is encrypted at rest.
    const [row] = await env.db.system((q) =>
      q.query<{ totp_pending_secret: string }>(`SELECT totp_pending_secret FROM users WHERE email = 'gina@mfa.test'`),
    );
    expect(row!.totp_pending_secret).toMatch(/^v1\./);
    expect(row!.totp_pending_secret).not.toContain(secret);
  });

  it('an org admin can reset a user’s two-step login, which signs them out', async () => {
    const userId = await createUser('hank@mfa.test');
    const { browser } = await enrol('hank@mfa.test');

    const listed = (await admin.get('/api/users')).json() as { id: string; mfaEnabled: boolean }[];
    expect(listed.find((u) => u.id === userId)!.mfaEnabled).toBe(true);

    // Not for regular developers, and not for yourself.
    const adminId = (await admin.get('/api/auth/me')).json().user.id as string;
    expect((await browser.patch(`/api/users/${adminId}`, { resetMfa: true })).statusCode).toBe(403);
    expect((await admin.patch(`/api/users/${adminId}`, { resetMfa: true })).statusCode).toBe(400);

    const pending = await passwordStep('hank@mfa.test');
    const r = await admin.patch(`/api/users/${userId}`, { resetMfa: true });
    expect(r.statusCode).toBe(200);
    expect(r.json().mfaEnabled).toBe(false);

    expect((await browser.get('/api/auth/me')).statusCode).toBe(401);
    // A challenge issued before the reset is gone.
    const late = await pending.b.post('/api/auth/login/mfa', { challenge: pending.challenge, code: '123456' });
    expect(late.json().error.code).toBe('mfa_expired');
    await signInPasswordOnly('hank@mfa.test');

    const [codes] = await env.db.system((q) =>
      q.query<{ n: number }>('SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1', [userId]),
    );
    expect(codes!.n).toBe(0);
    const audit = await env.db.system((q) =>
      q.query<{ details: { mfaReset?: boolean } }>(`SELECT details FROM audit_events WHERE action = 'user.updated' AND resource_id = $1`, [userId]),
    );
    expect(audit.some((a) => a.details.mfaReset === true)).toBe(true);
  });

  it('the request role cannot read login challenges', async () => {
    await expect(env.db.tenant(orgId, (q) => q.query('SELECT * FROM mfa_challenges'))).rejects.toThrow();
  });

  it('never leaks secrets or codes in responses (outside setup/enable) or the audit log', async () => {
    // A few reads that might be tempted to include them.
    seenResponses.push({ url: '/api/users', body: (await admin.get('/api/users')).body });
    seenResponses.push({ url: '/api/audit', body: (await admin.get('/api/audit?limit=200')).body });

    const oneTime = /\/api\/me\/mfa\/(setup|enable|recovery-codes)$/;
    const plain = secrets.flatMap((s) => [s, s.replace(/-/g, '')]);
    for (const { url, body } of seenResponses) {
      if (oneTime.test(url)) continue;
      for (const s of plain) expect(body, url).not.toContain(s);
      expect(body, url).not.toMatch(/totp_?secret|totp_?pending|code_?hash|v1\.[A-Za-z0-9_-]+\./i);
    }

    const events = await env.db.system((q) =>
      q.query<{ action: string; outcome: string; details: string }>('SELECT action, outcome, details::text AS details FROM audit_events'),
    );
    for (const e of events) for (const s of plain) expect(e.details, e.action).not.toContain(s);
    const actions = new Set(events.map((e) => `${e.action}:${e.outcome}`));
    for (const a of ['auth.mfa:success', 'auth.mfa:denied', 'mfa.setup:success', 'mfa.enable:success', 'mfa.enable:denied',
      'mfa.disable:success', 'mfa.disable:denied', 'mfa.recovery_codes:success', 'mfa.recovery_codes:denied']) {
      expect(actions, a).toContain(a);
    }
  });
});
