import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { perUserRateLimit } from '../../src/utils/rate-limit';

const app = Fastify();

beforeAll(async () => {
  await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
  app.post('/like', {
    config: { rateLimit: perUserRateLimit(2) },
    // Stands in for app.authenticate: route preHandlers run before the limiter.
    preHandler: [
      async (request: FastifyRequest) => {
        request.user = { userId: String(request.headers['x-user']) } as never;
      },
    ],
  }, async () => ({ ok: true }));
  await app.ready();
});

afterAll(() => app.close());

const like = (user: string) =>
  app.inject({ method: 'POST', url: '/like', headers: { 'x-user': user } });

describe('perUserRateLimit', () => {
  it('limits each authenticated user separately, even from the same IP', async () => {
    expect((await like('a')).statusCode).toBe(200);
    expect((await like('a')).statusCode).toBe(200);
    expect((await like('a')).statusCode).toBe(429);

    expect((await like('b')).statusCode).toBe(200);
  });
});
