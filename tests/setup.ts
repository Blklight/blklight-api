import { vi } from 'vitest';

vi.mock('../src/config/env', () => ({
  env: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_ACCESS_SECRET: 'test-access-secret-minimum-32-chars',
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
    JWT_REFRESH_REMEMBER_TTL: '30d',
    PORT: 3000,
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    CORS_ORIGIN: 'http://localhost:3000',
    CORS_ORIGINS: ['http://localhost:3000'],
    TRUST_PROXY_VALUE: false,
    COOKIE_SAMESITE: 'strict',
    MAX_SESSIONS_PER_USER: 5,
    RATE_LIMIT_DOCS_CREATE_MAX: 100000,
    RATE_LIMIT_DOCS_PUBLISH_MAX: 100000,
    SIGNATURE_ENCRYPTION_KEY: '0'.repeat(64),
    GITHUB_CLIENT_ID: 'test',
    GITHUB_CLIENT_SECRET: 'test',
    GOOGLE_CLIENT_ID: 'test',
    GOOGLE_CLIENT_SECRET: 'test',
    OAUTH_REDIRECT_BASE_URL: 'http://localhost:3000',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));
