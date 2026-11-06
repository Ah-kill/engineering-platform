import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238) as used by authenticator apps:
 * HMAC-SHA1, 6 digits, 30-second steps, accepting one step either side for clock drift.
 */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
const WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding, the format authenticator apps expect. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new shared secret: 20 random bytes (160 bits, the RFC 4226 recommendation), base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

/** RFC 4226 HOTP with dynamic truncation. */
export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS, algorithm: TotpAlgorithm = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return binary.toString().padStart(digits, '0');
}

export function totpStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for a base32 secret at a given time. */
export function totpCode(secret: string, nowMs: number = Date.now()): string {
  return hotp(base32Decode(secret), totpStep(nowMs));
}

/**
 * Checks a code against the current step and one either side. Steps at or before
 * `lastStep` are never accepted, so a code cannot be replayed. Every candidate is
 * compared in constant time. Returns the matching step (to store as the new last step).
 */
export function verifyTotp(
  secret: string,
  code: string,
  opts: { lastStep?: number | null; nowMs?: number } = {},
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret);
  const current = totpStep(opts.nowMs);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (let step = current - WINDOW; step <= current + WINDOW; step++) {
    const ok = timingSafeEqual(Buffer.from(hotp(key, step)), given);
    const fresh = opts.lastStep == null || step > opts.lastStep;
    if (ok && fresh && matched === null) matched = step;
  }
  return matched;
}

export function otpauthUrl(opts: { secret: string; issuer: string; account: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  // Spaces as %20, not '+': some authenticator apps show a literal '+' in the issuer.
  const params = [
    `secret=${opts.secret}`,
    `issuer=${encodeURIComponent(opts.issuer)}`,
    'algorithm=SHA1',
    `digits=${TOTP_DIGITS}`,
    `period=${TOTP_PERIOD_SECONDS}`,
  ];
  return `otpauth://totp/${label}?${params.join('&')}`;
}
