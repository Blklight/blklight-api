import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index';
import { registerSchema, loginSchema, usernameSchema } from './auth.zod';
import {
  registerUser,
  loginUser,
  refreshSession,
  logout,
  buildAuthSession,
  getOnboardingStep,
  setOnboardingUsername,
  completeOnboarding,
  createSessionWithReply,
} from './auth.service';
import { users } from './auth.schema';
import { ForbiddenError } from '../../utils/errors';
import { verifyEmail, sendVerificationEmail, sendPasswordResetEmail, resetPassword } from '../email/email.service';
import { requireFeature } from '../../config/features';
import { env } from '../../config/env';
import {
  REFRESH_COOKIE_NAME,
  buildSessionRefreshCookieOptions,
  buildRefreshCookieClearOptions,
} from '../../config/cookies';

/**
 * Reject cookie-authenticated auth routes when the browser Origin is outside
 * the CORS allowlist.
 *
 * SameSite already blocks the cookie on most cross-site requests, but it is not
 * a complete CSRF control: SameSite=None allows the cookie cross-site, and some
 * browsers/clients send the header regardless. Checking Origin closes the gap
 * for the two routes that act purely on the cookie, without needing a token
 * pattern or changing the cookie contract.
 *
 * Requests without an Origin header (curl, server-to-server, native clients)
 * are allowed through: the refresh cookie is still required, and a cross-site
 * attacker in a browser always sends Origin on a CORS-relevant request.
 * @param request - Incoming request
 * @throws ForbiddenError if Origin is present and not in the allowlist
 */
async function assertAllowedOrigin(request: FastifyRequest): Promise<void> {
  const origin = request.headers.origin;
  if (!origin) {
    return;
  }

  if (!env.CORS_ORIGINS.includes(origin)) {
    throw new ForbiddenError('Origin not allowed');
  }
}

export default async function authRoutes(app: FastifyInstance) {
  app.post('/register', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
    schema: {
      summary: 'Register a new user',
      tags: ['auth'],
      body: {
        type: 'object',
        required: ['email', 'username', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          username: { type: 'string', minLength: 3, maxLength: 30 },
          password: { type: 'string' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                accessToken: { type: 'string' },
                user: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    email: { type: 'string' },
                    username: { type: 'string' },
                    role: { type: 'string', enum: ['user', 'admin'] },
                    emailVerified: { type: 'boolean' },
                    onboardingComplete: { type: 'boolean' },
                    createdAt: { type: 'string' },
                  },
                },
                profile: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    userId: { type: 'string' },
                    username: { type: 'string' },
                    displayName: { type: ['string', 'null'] },
                    avatarUrl: { type: ['string', 'null'] },
                    isPrivate: { type: 'boolean' },
                  },
                },
                apps: { type: 'array', items: { type: 'string' } },
              },
            },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        data: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          fields: Object.fromEntries(
            parsed.error.issues.map((i) => [i.path.join('.'), i.message])
          ),
        },
        message: 'Validation failed',
      });
    }

    const { email, username, password } = parsed.data;
    const { user, refreshToken } = await registerUser(email, username, password);

    const accessToken = app.jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      { expiresIn: env.JWT_ACCESS_EXPIRES_IN }
    );

    const authSession = await buildAuthSession(user.id, accessToken);

    reply
      .code(201)
      .setCookie(REFRESH_COOKIE_NAME, refreshToken, buildSessionRefreshCookieOptions(false))
      .send({
        data: authSession,
        error: null,
        message: 'User registered successfully',
      });
  });

  app.post('/login', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
    schema: {
      summary: 'Login with email or username',
      tags: ['auth'],
      body: {
        type: 'object',
        required: ['identifier', 'password'],
        properties: {
          identifier: { type: 'string', minLength: 1 },
          password: { type: 'string' },
          rememberMe: { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                accessToken: { type: 'string' },
                user: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    email: { type: 'string' },
                    username: { type: 'string' },
                    role: { type: 'string', enum: ['user', 'admin'] },
                    emailVerified: { type: 'boolean' },
                    onboardingComplete: { type: 'boolean' },
                    createdAt: { type: 'string' },
                  },
                },
                profile: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    userId: { type: 'string' },
                    username: { type: 'string' },
                    displayName: { type: ['string', 'null'] },
                    avatarUrl: { type: ['string', 'null'] },
                    isPrivate: { type: 'boolean' },
                  },
                },
                apps: { type: 'array', items: { type: 'string' } },
              },
            },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        data: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          fields: Object.fromEntries(
            parsed.error.issues.map((i) => [i.path.join('.'), i.message])
          ),
        },
        message: 'Validation failed',
      });
    }

    const { identifier, password, rememberMe } = parsed.data;
    const { userId, refreshToken, role, email } = await loginUser(identifier, password, rememberMe);

    const accessToken = app.jwt.sign(
      { userId, email, role },
      { expiresIn: env.JWT_ACCESS_EXPIRES_IN }
    );

    const authSession = await buildAuthSession(userId, accessToken);

    reply.setCookie(
      REFRESH_COOKIE_NAME,
      refreshToken,
      buildSessionRefreshCookieOptions(rememberMe)
    ).send({
      data: authSession,
      error: null,
      message: 'Login successful',
    });
  });

  app.post('/refresh', {
    onRequest: assertAllowedOrigin,
    schema: {
      summary: 'Refresh access token',
      tags: ['auth'],
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                accessToken: { type: 'string' },
                user: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    email: { type: 'string' },
                    username: { type: 'string' },
                    role: { type: 'string', enum: ['user', 'admin'] },
                    emailVerified: { type: 'boolean' },
                    onboardingComplete: { type: 'boolean' },
                    createdAt: { type: 'string' },
                  },
                },
                profile: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    userId: { type: 'string' },
                    username: { type: 'string' },
                    displayName: { type: ['string', 'null'] },
                    avatarUrl: { type: ['string', 'null'] },
                    isPrivate: { type: 'boolean' },
                  },
                },
                apps: { type: 'array', items: { type: 'string' } },
              },
            },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const refreshToken = request.cookies[REFRESH_COOKIE_NAME];
    if (!refreshToken) {
      return reply.code(401).send({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Refresh token required' },
        message: 'Authentication required',
      });
    }

    const { user, rotatedToken, rememberMe } = await refreshSession(refreshToken);
    const accessToken = app.jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      { expiresIn: env.JWT_ACCESS_EXPIRES_IN }
    );

    const authSession = await buildAuthSession(user.id, accessToken);

    // A replay inside the grace window returns rotatedToken = null: the browser
    // already holds the newer cookie from the first rotation, and overwriting
    // it here would hand back a token the server just consumed.
    if (rotatedToken !== null) {
      reply.setCookie(
        REFRESH_COOKIE_NAME,
        rotatedToken,
        buildSessionRefreshCookieOptions(rememberMe)
      );
    }

    reply.send({
      data: authSession,
      error: null,
      message: 'Token refreshed',
    });
  });

  app.post('/logout', {
    onRequest: assertAllowedOrigin,
    schema: {
      summary: 'Logout and invalidate refresh token',
      tags: ['auth'],
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'null' },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const refreshToken = request.cookies[REFRESH_COOKIE_NAME];
    if (refreshToken) {
      await logout(refreshToken);
    }

    reply.clearCookie(REFRESH_COOKIE_NAME, buildRefreshCookieClearOptions()).send({
      data: null,
      error: null,
      message: 'Logged out successfully',
    });
  });

  app.get('/onboarding/status', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Get onboarding status',
      tags: ['auth'],
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                step: { type: 'string' },
                user: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    email: { type: 'string' },
                    username: { type: 'string' },
                    role: { type: 'string' },
                    emailVerified: { type: 'boolean' },
                    onboardingComplete: { type: 'boolean' },
                    createdAt: { type: 'string' },
                    hasPassword: { type: 'boolean' },
                  },
                },
                profile: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    userId: { type: 'string' },
                    username: { type: 'string' },
                    displayName: { type: ['string', 'null'] },
                    avatarUrl: { type: ['string', 'null'] },
                    isPrivate: { type: 'boolean' },
                  },
                },
                apps: { type: 'array', items: { type: 'string' } },
              },
            },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user.userId;

    const [userRow] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!userRow) {
      return reply.code(404).send({
        data: null,
        error: { code: 'NOT_FOUND', message: 'User not found' },
        message: 'User not found',
      });
    }

    const authSession = await buildAuthSession(userId, '');
    const step = getOnboardingStep({
      username: userRow.username,
      onboardingComplete: userRow.onboardingComplete,
      passwordHash: userRow.passwordHash,
    });

    const { accessToken: _, ...sessionWithoutToken } = authSession;

    reply.send({
      data: {
        step,
        ...sessionWithoutToken,
        user: {
          ...sessionWithoutToken.user,
          hasPassword: userRow.passwordHash !== null,
        },
      },
      error: null,
      message: 'Onboarding status retrieved',
    });
  });

  app.post('/onboarding/username', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Set username during OAuth onboarding',
      tags: ['auth'],
      body: {
        type: 'object',
        required: ['username'],
        properties: {
          username: { type: 'string', minLength: 3, maxLength: 30 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'null' },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = z.object({ username: usernameSchema }).safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        data: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          fields: Object.fromEntries(
            parsed.error.issues.map((i) => [i.path.join('.'), i.message])
          ),
        },
        message: 'Validation failed',
      });
    }

    const userId = request.user.userId;
    await setOnboardingUsername(userId, parsed.data.username);

    reply.send({
      data: null,
      error: null,
      message: 'Username set successfully',
    });
  });

  app.post('/onboarding/complete', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Create onboarding records (profile, signature, workspace, canvas)',
      tags: ['auth'],
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'null' },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user.userId;
    await completeOnboarding(userId);
    await createSessionWithReply(userId, reply);

    reply.send({
      data: null,
      error: null,
      message: 'Onboarding complete',
    });
  });

  app.post('/verify-email', {
    schema: {
      summary: 'Verify email address',
      tags: ['auth'],
      body: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'null' },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    requireFeature('email');

    const parsed = z.object({ token: z.string() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        data: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          fields: Object.fromEntries(
            parsed.error.issues.map((i) => [i.path.join('.'), i.message])
          ),
        },
        message: 'Validation failed',
      });
    }

    await verifyEmail(parsed.data.token);

    reply.send({
      data: null,
      error: null,
      message: 'Email verified successfully',
    });
  });

  app.post('/resend-verification', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    config: {
      rateLimit: {
        max: 3,
        timeWindow: '1 hour',
      },
    },
    schema: {
      summary: 'Resend verification email',
      tags: ['auth'],
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'null' },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    requireFeature('email');

    const userId = request.user.userId;

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      return reply.code(404).send({
        data: null,
        error: { code: 'NOT_FOUND', message: 'User not found' },
        message: 'User not found',
      });
    }

    await sendVerificationEmail(user.id, user.email, user.username);

    reply.send({
      data: null,
      error: null,
      message: 'Verification email queued',
    });
  });

  app.post('/forgot-password', {
    config: {
      rateLimit: {
        max: 3,
        timeWindow: '1 hour',
      },
    },
    schema: {
      summary: 'Request password reset',
      tags: ['auth'],
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'null' },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    requireFeature('email');

    const parsed = z.object({ email: z.string().email() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        data: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          fields: Object.fromEntries(
            parsed.error.issues.map((i) => [i.path.join('.'), i.message])
          ),
        },
        message: 'Validation failed',
      });
    }

    await sendPasswordResetEmail(parsed.data.email);

    reply.send({
      data: null,
      error: null,
      message: 'If this email exists, a reset link has been queued',
    });
  });

  app.post('/reset-password', {
    schema: {
      summary: 'Reset password',
      tags: ['auth'],
      body: {
        type: 'object',
        required: ['token', 'password'],
        properties: {
          token: { type: 'string' },
          password: { type: 'string', minLength: 8, maxLength: 128 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'null' },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    requireFeature('email');

    const parsed = z.object({
      token: z.string(),
      password: z.string().min(8).max(128),
    }).safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        data: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          fields: Object.fromEntries(
            parsed.error.issues.map((i) => [i.path.join('.'), i.message])
          ),
        },
        message: 'Validation failed',
      });
    }

    await resetPassword(parsed.data.token, parsed.data.password);

    reply.send({
      data: null,
      error: null,
      message: 'Password reset successfully. Please log in again.',
    });
  });
}
