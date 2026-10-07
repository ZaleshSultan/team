import { createHash, randomBytes } from 'node:crypto';

/** High-entropy bearer credentials; persist only hashSecret(secret). */
export function createSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}
