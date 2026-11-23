import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { config } from 'dotenv';

config({ path: '.env.development', override: true });
const SQL_URL = process.env.DATABASE_URL ?? '';

/**
 * POST /api/v1/uploads against the real dev database through app.inject.
 * S3 is stubbed (S3Client.send) so the suite does not need the local MinIO.
 */
vi.mock('../../src/config/env', async () => {
  const { config: loadEnv } = await import('dotenv');
  loadEnv({ path: '.env.development', override: true });
  process.env.NODE_ENV = 'development';
  const actual = await vi.importActual<typeof import('../../src/config/env')>('../../src/config/env');
  return {
    ...actual,
    env: {
      ...actual.env,
      FEATURE_EMAIL: false,
      FEATURE_OAUTH: false,
      FEATURE_MEMORY: false,
      FEATURE_UPLOADS: true,
      BUCKET_NAME: 'test-bucket',
      UPLOADS_PUBLIC_BASE_URL: 'http://localhost:9000/test-bucket',
      LOG_LEVEL: 'silent',
    },
  };
});

import postgres from 'postgres';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { FastifyInstance } from 'fastify';
import { db } from '../../src/db/index';
import { env } from '../../src/config/env';
import { features } from '../../src/config/features';
import { buildApp } from '../../src/app';
import { createUser } from '../../src/features/auth/auth.service';
import { uploads } from '../../src/features/uploads/uploads.schema';
import { purgeRows } from './helpers/purge';

const sql = postgres(SQL_URL, { max: 1 });
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PREFIX = `upl-${RUN_ID}-`;

const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);

let app: FastifyInstance;
let userId = '';
let token = '';

function multipart(file: Buffer, filename = 'photo.jpg', contentType = 'image/jpeg') {
  const boundary = `----blklight${RUN_ID}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function upload(purpose: string, body: ReturnType<typeof multipart>, auth = true) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/uploads?purpose=${purpose}`,
    headers: { ...body.headers, ...(auth ? { authorization: `Bearer ${token}` } : {}) },
    payload: body.payload,
  });
}

const jpeg = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#224488' } }).jpeg().toBuffer();

beforeAll(async () => {
  expect(SQL_URL).not.toBe('');
  app = await buildApp();
  await app.ready();
  const username = `${PREFIX}u`.replace(/[^a-z0-9_]/g, '_');
  const { user } = await createUser(`${PREFIX}u@example.test`, username, 'Password123!');
  userId = user.id;
  token = app.jwt.sign({ userId: user.id, email: user.email, role: user.role }, { expiresIn: env.JWT_ACCESS_EXPIRES_IN });
});

afterAll(async () => {
  await purgeRows(sql, 'users', 'id', [userId]);
  await app.close();
  await sql.end();
});

describe('POST /api/v1/uploads', () => {
  it('requires authentication', async () => {
    const res = await upload('editor', multipart(await jpeg(10, 10)), false);
    expect(res.statusCode).toBe(401);
  });

  it('stores an avatar as 512x512 WebP and records it', async () => {
    send.mockClear();
    const res = await upload('avatar', multipart(await jpeg(900, 600)));
    expect(res.statusCode, res.body).toBe(201);

    const { data } = res.json() as { data: { url: string; width: number; height: number; bytes: number } };
    expect(data.url).toMatch(new RegExp(`^http://localhost:9000/test-bucket/avatar/${userId}/[a-z0-9]+\\.webp$`));
    expect([data.width, data.height]).toEqual([512, 512]);

    const command = send.mock.calls[0]![0] as PutObjectCommand;
    expect(command.input).toMatchObject({ Bucket: 'test-bucket', ContentType: 'image/webp' });

    const [row] = await db.select().from(uploads).where(eq(uploads.userId, userId));
    expect(row).toMatchObject({ purpose: 'avatar', width: 512, height: 512, bytes: data.bytes });
  });

  it('rejects an invalid purpose', async () => {
    const res = await upload('banner', multipart(await jpeg(10, 10)));
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-image disguised as JPEG', async () => {
    const res = await upload('editor', multipart(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')));
    expect(res.statusCode).toBe(400);
  });

  it('rejects a request without multipart body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads?purpose=editor',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 when uploads are disabled', async () => {
    (features as { uploads: boolean }).uploads = false;
    try {
      const res = await upload('editor', multipart(await jpeg(10, 10)));
      expect(res.statusCode).toBe(503);
    } finally {
      (features as { uploads: boolean }).uploads = true;
    }
  });
});
