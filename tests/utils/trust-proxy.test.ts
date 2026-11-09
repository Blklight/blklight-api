import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from '../../src/utils/trust-proxy';

describe('parseTrustProxy', () => {
  it('does not trust proxies when unset or false', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('parses true and address lists', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('10.0.0.0/8, 127.0.0.1')).toEqual(['10.0.0.0/8', '127.0.0.1']);
  });

  it('rejects hop counts, which let direct clients spoof X-Forwarded-For', () => {
    expect(() => parseTrustProxy('1')).toThrow(/hop counts are not supported/);
  });

  it('makes request.ip the client address behind a trusted proxy', async () => {
    // app.inject connects from 127.0.0.1, which plays the proxy here.
    const app = Fastify({ trustProxy: parseTrustProxy('127.0.0.1') });
    app.get('/ip', async (request) => ({ ip: request.ip }));

    const response = await app.inject({
      url: '/ip',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });

    expect(response.json()).toEqual({ ip: '203.0.113.7' });
    await app.close();
  });
});
