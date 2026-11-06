import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Encrypts credentials (API keys, tokens) before they reach the database.
 * AES-256-GCM, fresh 12-byte IV per value; stored as `v1.<iv>.<tag>.<ciphertext>` (base64url).
 *
 * The master key comes from VAULT_KEY (base64, 32 bytes). For local development, if
 * it is unset, a key is generated once into a file next to the data directory.
 * In production this is replaced by AWS KMS envelope encryption.
 */
export class Vault {
  private constructor(private readonly key: Buffer) {}

  static fromKey(base64Key: string): Vault {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) throw new Error('VAULT_KEY must be 32 bytes, base64-encoded');
    return new Vault(key);
  }

  static async fromKeyFile(file: string): Promise<{ vault: Vault; created: boolean }> {
    try {
      return { vault: Vault.fromKey((await readFile(file, 'utf8')).trim()), created: false };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await mkdir(path.dirname(file), { recursive: true });
      const key = randomBytes(32).toString('base64');
      await writeFile(file, key, { mode: 0o600, flag: 'wx' });
      return { vault: Vault.fromKey(key), created: true };
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  decrypt(sealed: string): string {
    const [version, iv, tag, ct] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unrecognised ciphertext format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}

export function hintFor(secret: string): string {
  return secret.length <= 8 ? '••••' : `…${secret.slice(-4)}`;
}
