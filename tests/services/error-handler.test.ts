import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/config/env', async () => {
  const { config: loadEnv } = await import('dotenv');
  loadEnv({ path: '.env.development', override: true });
  process.env.NODE_ENV = 'development';
  const actual = await vi.importActual<typeof import('../../src/config/env')>('../../src/config/env');
  return { ...actual, env: { ...actual.env, LOG_LEVEL: 'silent', FEATURE_OAUTH: false, FEATURE_EMAIL: false, FEATURE_MEMORY: false } };
});

import { z } from 'zod';
import { buildApp } from '../../src/app';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  app.get('/__unique-violation', async () => {
    throw Object.assign(new Error('Failed query: insert into users'), {
      cause: { code: '23505', detail: 'Key (email)=(a@b.c) already exists.' },
    });
  });
  app.post('/__zod', async (request) => z.object({ title: z.string().min(1), tags: z.array(z.string()).max(1) }).parse(request.body));
  await app.ready();
});

afterAll(() => app.close());

describe('error handler', () => {
  it('answers a Postgres unique violation with 409 instead of 500', async () => {
    const response = await app.inject('/__unique-violation');
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ data: null, error: { code: 'CONFLICT' } });
  });

  it('turns a ZodError from a route into the 400 envelope with per-field messages', async () => {
    const response = await app.inject({ method: 'POST', url: '/__zod', payload: { title: '', tags: ['a', 'b'] } });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { data: null; error: { code: string; fields: Record<string, string> }; message: string };
    expect(body).toMatchObject({ data: null, message: 'Validation failed', error: { code: 'VALIDATION_ERROR' } });
    expect(Object.keys(body.error.fields).sort()).toEqual(['tags', 'title']);
  });
});
