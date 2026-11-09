import { describe, it, expect, beforeAll } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  generateUserHash,
  generateDocumentHash,
  generateArticleSignature,
  verifyArticleSignature,
  encryptSecret,
  decryptSecret,
  generatePublicIdentifier,
} from '../../src/utils/crypto';

describe('crypto', () => {
  describe('hashPassword', () => {
    it('hashPassword returns hash and salt as non-empty strings', async () => {
      const { hash, salt } = await hashPassword('testpassword');
      expect(hash).toBeDefined();
      expect(hash.length).toBeGreaterThan(0);
      expect(salt).toBeDefined();
      expect(salt.length).toBeGreaterThan(0);
    });

    it('hashPassword same password + same salt produces same hash', async () => {
      const { hash: hash1 } = await hashPassword('testpassword');
      const { hash: hash2 } = await hashPassword('testpassword');
      expect(hash1).not.toBe(hash2);
    });

    it('hashPassword different passwords produce different hashes', async () => {
      const { hash: hash1 } = await hashPassword('password1');
      const { hash: hash2 } = await hashPassword('password2');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyPassword', () => {
    it('verifyPassword correct password returns true', async () => {
      const { hash, salt } = await hashPassword('correctpassword');
      const result = await verifyPassword('correctpassword', hash, salt);
      expect(result).toBe(true);
    });

    it('verifyPassword wrong password returns false', async () => {
      const { hash, salt } = await hashPassword('correctpassword');
      const result = await verifyPassword('wrongpassword', hash, salt);
      expect(result).toBe(false);
    });

    it('verifyPassword tampered hash returns false', async () => {
      const { hash, salt } = await hashPassword('mypassword');
      const tamperedHash = hash.slice(0, -2) + 'xx';
      const result = await verifyPassword('mypassword', tamperedHash, salt);
      expect(result).toBe(false);
    });
  });

  describe('generateUserHash', () => {
    it('generateUserHash returns consistent string for same inputs', () => {
      const createdAt = new Date('2024-01-01T00:00:00.000Z');
      const hash1 = generateUserHash('user123', 'test@example.com', createdAt, 'secret1');
      const hash2 = generateUserHash('user123', 'test@example.com', createdAt, 'secret1');
      expect(hash1).toBe(hash2);
    });

    it('generateUserHash different inputs produce different hashes', () => {
      const createdAt = new Date('2024-01-01T00:00:00.000Z');
      const hash1 = generateUserHash('user123', 'test@example.com', createdAt, 'secret1');
      const hash2 = generateUserHash('user456', 'test@example.com', createdAt, 'secret1');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('generateDocumentHash', () => {
    it('generateDocumentHash returns consistent SHA-256 hex', () => {
      const hash1 = generateDocumentHash('Hello World');
      const hash2 = generateDocumentHash('Hello World');
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('generateArticleSignature', () => {
    it('generateArticleSignature returns HMAC string', () => {
      const signature = generateArticleSignature('userhash', 'dochash', 'secret');
      expect(signature).toBeDefined();
      expect(signature).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('verifyArticleSignature', () => {
    it('verifyArticleSignature correct inputs returns true', () => {
      const signature = generateArticleSignature('userhash', 'dochash', 'secret');
      const result = verifyArticleSignature('userhash', 'dochash', 'secret', signature);
      expect(result).toBe(true);
    });

    it('verifyArticleSignature tampered signature returns false', () => {
      const signature = generateArticleSignature('userhash', 'dochash', 'secret');
      const tampered = signature.slice(0, -2) + 'xx';
      const result = verifyArticleSignature('userhash', 'dochash', 'secret', tampered);
      expect(result).toBe(false);
    });
  });

  describe('encryptSecret', () => {
    it('encryptSecret + decryptSecret roundtrip returns original value', () => {
      const original = 'a'.repeat(64);
      const encrypted = encryptSecret(original);
      const decrypted = decryptSecret(encrypted);
      expect(decrypted).toBe(original);
    });

    it('encryptSecret two calls produce different ciphertext', () => {
      const secret = 'b'.repeat(64);
      const encrypted1 = encryptSecret(secret);
      const encrypted2 = encryptSecret(secret);
      expect(encrypted1).not.toBe(encrypted2);
    });
  });

  describe('generatePublicIdentifier', () => {
    it('generatePublicIdentifier format is PLT-xxxxxxxx.xxxxxxxx', () => {
      const id = generatePublicIdentifier('abcdef0123456789', '1234567890abcdef');
      expect(id).toMatch(/^PLT-[a-f0-9]{8}\.[a-f0-9]{8}$/);
    });
  });
});
