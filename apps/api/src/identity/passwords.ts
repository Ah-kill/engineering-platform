import { hash, verify } from '@node-rs/argon2';

export const MIN_PASSWORD_LENGTH = 12;

// OWASP-recommended Argon2id parameters (19 MiB, 2 iterations).
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Used to keep login timing similar whether or not the email exists.
let dummyHash: Promise<string> | undefined;
export function dummyVerify(password: string): Promise<boolean> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  return dummyHash.then((h) => verifyPassword(h, password));
}
