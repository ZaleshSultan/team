import { describe, expect, it } from 'vitest';
import { createSecret, hashSecret } from '../src/auth/secrets.js';

describe('opaque secrets', () => {
  it('creates distinct 256-bit URL-safe credentials', () => {
    const secrets = Array.from({ length: 32 }, () => createSecret());
    expect(new Set(secrets).size).toBe(secrets.length);
    for (const secret of secrets) {
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    }
  });

  it('hashes the credential using UTF-8 SHA-256, without retaining its value', () => {
    expect(hashSecret('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const secret = createSecret();
    expect(hashSecret(secret)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSecret(secret)).not.toContain(secret);
    expect(hashSecret(`${secret}x`)).not.toBe(hashSecret(secret));
  });
});
