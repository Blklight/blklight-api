import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/config/env', async () => {
  const { config: loadEnv } = await import('dotenv');
  loadEnv({ path: '.env.development', override: true });
  process.env.NODE_ENV = 'development';
  const actual = await vi.importActual<typeof import('../../src/config/env')>('../../src/config/env');
  return { ...actual, env: { ...actual.env, LOG_LEVEL: 'silent', FEATURE_OAUTH: false, FEATURE_EMAIL: false, FEATURE_MEMORY: false } };
});

import { buildApp } from '../../src/app';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  app.get('/__unique-violation', async () => {
    throw Object.assign(new Error('Failed query: insert into users'), {
      cause: { code: '23505', detail: 'Key (email)=(a@b.c) already exists.' },
    });
  });
  await app.ready();
});

afterAll(() => app.close());

describe('error handler', () => {
  it('answers a Postgres unique violation with 409 instead of 500', async () => {
    const response = await app.inject('/__unique-violation');
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ data: null, error: { code: 'CONFLICT' } });
  });
});
