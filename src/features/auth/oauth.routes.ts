import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { OAuth2Namespace } from '@fastify/oauth2';
import {
  fetchGitHubUser,
  fetchGoogleUser,
  handleOAuthLogin,
  handleOAuthLink,
  unlinkProvider,
  type OAuthUser,
} from './oauth.service';
import { env } from '../../config/env';
import { createSessionWithReply } from './auth.service';
import { requireFeature } from '../../config/features';
import { ConflictError } from '../../utils/errors';
import {
  LINK_INTENT_TTL_MS,
  consumeLinkIntent,
  createLinkIntent,
  peekLinkIntent,
  type OAuthProvider,
} from './oauth-link-intents';

const LINK_COOKIE = 'oauthLinkIntent';
const LINK_COOKIE_PATH = '/api/v1/auth';

interface ProviderConfig {
  provider: OAuthProvider;
  label: string;
  client: (app: FastifyInstance) => OAuth2Namespace;
  fetchUser: (accessToken: string) => Promise<OAuthUser>;
}

const PROVIDERS: ProviderConfig[] = [
  { provider: 'github', label: 'GitHub', client: (app) => app.githubOAuth2, fetchUser: fetchGitHubUser },
  { provider: 'google', label: 'Google', client: (app) => app.googleOAuth2, fetchUser: fetchGoogleUser },
];

function linkCookieOptions(maxAgeSeconds?: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    path: LINK_COOKIE_PATH,
    ...(maxAgeSeconds === undefined ? {} : { maxAge: maxAgeSeconds }),
  };
}

function frontend(path: string): string {
  return `${env.FRONTEND_URL}${path}`;
}

export default async function oauthRoutes(app: FastifyInstance) {
  for (const { provider, label, client, fetchUser } of PROVIDERS) {
    // Login/register. The plugin stores a random state in a cookie and checks
    // it on the callback (CSRF), plus a PKCE verifier.
    app.get(`/${provider}`, {
      schema: { summary: `Redirect to ${label} OAuth`, tags: ['oauth'] },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      requireFeature('oauth');
      reply.clearCookie(LINK_COOKIE, linkCookieOptions());
      const uri = await client(app).generateAuthorizationUri(request, reply);
      return reply.redirect(uri);
    });

    // Linking, step 1 (fetch with the Bearer token): binds the intent to this
    // browser through an httpOnly cookie, then the front navigates to `url`.
    app.post(`/${provider}/link`, {
      preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
      schema: { summary: `Link ${label} account (start)`, tags: ['oauth'], security: [{ bearerAuth: [] }] },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      requireFeature('oauth');
      const intent = createLinkIntent(request.user.userId, provider);
      reply.setCookie(LINK_COOKIE, intent, linkCookieOptions(LINK_INTENT_TTL_MS / 1000));
      return reply.send({
        data: { url: `${env.OAUTH_REDIRECT_BASE_URL}${LINK_COOKIE_PATH}/${provider}/link/start` },
        error: null,
        message: 'Link intent created',
      });
    });

    // Linking, step 2 (browser navigation): only proceeds with a live intent.
    app.get(`/${provider}/link/start`, {
      schema: { summary: `Link ${label} account (redirect)`, tags: ['oauth'] },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      requireFeature('oauth');
      if (!peekLinkIntent(request.cookies[LINK_COOKIE], provider)) {
        return reply.redirect(frontend('/settings/account?error=link_expired'));
      }
      const uri = await client(app).generateAuthorizationUri(request, reply);
      return reply.redirect(uri);
    });

    // Single callback for both flows: the provider always returns to the
    // configured callbackUri, and the link cookie tells the flows apart.
    app.get(`/${provider}/callback`, {
      schema: { summary: `${label} OAuth callback`, tags: ['oauth'] },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      requireFeature('oauth');

      const intentId = request.cookies[LINK_COOKIE];
      const linking = intentId !== undefined;
      const errorBase = linking ? '/settings/account?error=' : '/login?error=';
      if (linking) reply.clearCookie(LINK_COOKIE, linkCookieOptions());

      let profile: OAuthUser;
      try {
        // Validates the state cookie and exchanges the code (with PKCE).
        const token = await client(app).getAccessTokenFromAuthorizationCodeFlow(request, reply);
        profile = await fetchUser(token.token.access_token);
      } catch (error) {
        request.log.warn({ err: error, provider }, 'oauth callback rejected');
        return reply.redirect(frontend(`${errorBase}oauth_failed`));
      }

      if (!profile.email) {
        return reply.redirect(frontend(`${errorBase}${provider}_verified_email_required`));
      }

      if (linking) {
        const userId = consumeLinkIntent(intentId, provider);
        if (!userId) {
          return reply.redirect(frontend('/settings/account?error=link_expired'));
        }
        try {
          await handleOAuthLink(userId, provider, profile.id);
        } catch (error) {
          if (error instanceof ConflictError) {
            return reply.redirect(frontend('/settings/account?error=already_linked'));
          }
          throw error;
        }
        return reply.redirect(frontend(`/settings/account?linked=${provider}`));
      }

      let result: Awaited<ReturnType<typeof handleOAuthLogin>>;
      try {
        result = await handleOAuthLogin(provider, profile.id, profile.email);
      } catch (error) {
        // An account with this email exists: the user must log in and link.
        if (error instanceof ConflictError) {
          return reply.redirect(frontend('/login?error=account_exists'));
        }
        throw error;
      }
      // Session travels in the httpOnly refresh cookie, never in the URL; the
      // front obtains an access token through /auth/refresh.
      await createSessionWithReply(result.userId, reply);
      return reply.redirect(frontend(result.onboardingComplete ? '/dashboard' : '/onboarding'));
    });
  }

  app.delete('/account/unlink/:provider', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Unlink OAuth provider',
      tags: ['oauth'],
      params: {
        type: 'object',
        properties: { provider: { type: 'string', enum: ['github', 'google'] } },
        required: ['provider'],
      },
      response: {
        200: { type: 'object', properties: { data: { type: 'null' }, error: { type: 'null' }, message: { type: 'string' } } },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    requireFeature('oauth');

    const { userId } = request.user;
    const params = request.params as { provider: OAuthProvider };
    await unlinkProvider(userId, params.provider);

    reply.send({
      data: null,
      error: null,
      message: 'Provider unlinked successfully',
    });
  });
}
