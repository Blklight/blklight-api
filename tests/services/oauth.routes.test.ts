import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';

vi.mock('../../src/config/features', () => ({
  features: { oauth: true },
  requireFeature: () => undefined,
}));

const service = vi.hoisted(() => ({
  fetchGitHubUser: vi.fn(),
  fetchGoogleUser: vi.fn(),
  handleOAuthLogin: vi.fn(),
  handleOAuthLink: vi.fn(),
  unlinkProvider: vi.fn(),
}));
vi.mock('../../src/features/auth/oauth.service', () => service);

const createSessionWithReply = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../src/features/auth/auth.service', () => ({ createSessionWithReply }));

import oauthRoutes from '../../src/features/auth/oauth.routes';
import { ConflictError } from '../../src/utils/errors';

function fakeProvider() {
  return {
    generateAuthorizationUri: vi.fn(async () => 'https://provider.example/authorize'),
    getAccessTokenFromAuthorizationCodeFlow: vi.fn(async () => ({ token: { access_token: 'provider-token' } })),
  };
}

let app: FastifyInstance;
const github = fakeProvider();

beforeAll(async () => {
  app = Fastify();
  await app.register(cookie);
  app.decorate('githubOAuth2', github as never);
  app.decorate('googleOAuth2', fakeProvider() as never);
  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.headers['x-user'];
    if (!user) return reply.code(401).send({});
    request.user = { userId: String(user) } as never;
  });
  await app.register(oauthRoutes, { prefix: '/api/v1/auth' });
  await app.ready();
});

afterAll(() => app.close());

beforeEach(() => {
  vi.clearAllMocks();
  service.fetchGitHubUser.mockResolvedValue({ id: 'gh-1', email: 'gh@example.com', name: 'GH' });
  service.handleOAuthLogin.mockResolvedValue({ userId: 'u-new', onboardingComplete: false, isNew: true });
});

function cookieFrom(response: { cookies: Array<{ name: string; value: string }> }, name: string) {
  return response.cookies.find((c) => c.name === name);
}

describe('OAuth login', () => {
  it('starts a session in a cookie and never puts a token in the redirect URL', async () => {
    const response = await app.inject({ url: '/api/v1/auth/github/callback?code=c&state=s' });

    expect(github.getAccessTokenFromAuthorizationCodeFlow).toHaveBeenCalled();
    expect(createSessionWithReply).toHaveBeenCalledWith('u-new', expect.anything());
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toMatch(/\/onboarding$/);
    expect(response.headers.location).not.toMatch(/token=/);
  });

  it('redirects with an error when the state/code exchange fails', async () => {
    github.getAccessTokenFromAuthorizationCodeFlow.mockRejectedValueOnce(new Error('Invalid state'));
    const response = await app.inject({ url: '/api/v1/auth/github/callback?code=c&state=forged' });

    expect(response.headers.location).toMatch(/\/login\?error=oauth_failed$/);
    expect(createSessionWithReply).not.toHaveBeenCalled();
  });

  it('asks the user to log in and link when the email already has an account', async () => {
    service.handleOAuthLogin.mockRejectedValueOnce(new ConflictError('exists'));
    const response = await app.inject({ url: '/api/v1/auth/github/callback?code=c&state=s' });
    expect(response.headers.location).toMatch(/\/login\?error=account_exists$/);
  });
});

describe('OAuth account linking', () => {
  it('binds the link to the browser that requested it', async () => {
    const started = await app.inject({ method: 'POST', url: '/api/v1/auth/github/link', headers: { 'x-user': 'u-1' } });
    const intent = cookieFrom(started, 'oauthLinkIntent');
    expect(intent).toMatchObject({ httpOnly: true, path: '/api/v1/auth' });

    const withoutCookie = await app.inject({ url: '/api/v1/auth/github/link/start' });
    expect(withoutCookie.headers.location).toMatch(/error=link_expired/);

    const withCookie = await app.inject({
      url: '/api/v1/auth/github/link/start',
      cookies: { oauthLinkIntent: intent!.value },
    });
    expect(withCookie.headers.location).toBe('https://provider.example/authorize');

    const callback = await app.inject({
      url: '/api/v1/auth/github/callback?code=c&state=s',
      cookies: { oauthLinkIntent: intent!.value },
    });
    expect(service.handleOAuthLink).toHaveBeenCalledWith('u-1', 'github', 'gh-1');
    expect(service.handleOAuthLogin).not.toHaveBeenCalled();
    expect(callback.headers.location).toMatch(/linked=github$/);

    // Single use: replaying the same cookie does not link again.
    const replay = await app.inject({
      url: '/api/v1/auth/github/callback?code=c&state=s',
      cookies: { oauthLinkIntent: intent!.value },
    });
    expect(replay.headers.location).toMatch(/error=link_expired/);
    expect(service.handleOAuthLink).toHaveBeenCalledTimes(1);
  });

  it('requires authentication to create a link intent', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/github/link' });
    expect(response.statusCode).toBe(401);
  });
});
