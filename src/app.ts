import Fastify, {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  type FastifySchemaValidationError,
} from 'fastify';
import { ZodError } from 'zod';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import oauth2 from '@fastify/oauth2';
import { env } from './config/env';
import { AppError, ValidationError, RateLimitError } from './utils/errors';
import authRoutes from './features/auth/auth.routes';
import profileRoutes from './features/profiles/profiles.routes';
import documentRoutes from './features/documents/documents.routes';
import styleTemplateRoutes from './features/document-style-templates/document-style-templates.routes';
import tutorialExerciseRoutes from './features/tutorial-exercises/tutorial-exercises.routes';
import likesRoutes from './features/likes/likes.routes';
import bookmarksRoutes from './features/bookmarks/bookmarks.routes';
import categoryRoutes from './features/categories/categories.routes';
import tagRoutes from './features/tags/tags.routes';
import bookRoutes from './features/books/books.routes';
import highlightRoutes from './features/highlights/highlights.routes';
import documentHighlightRoutes from './features/highlights/document-highlight.routes';
import workspaceRoutes from './features/workspace/workspace.routes';
import noteRoutes from './features/notes/notes.routes';
import journalRoutes from './features/journals/journals.routes';
import followRoutes from './features/follows/follows.routes';
import oauthRoutes from './features/auth/oauth.routes';
import platformAppsRoutes from './features/platform-apps/platform-apps.routes';
import canvasRoutes from './features/canvas/canvas.routes';
import memoryRoutes from './features/memory/memory.routes';
import chatRoutes from './features/chat/chat.routes';
import organizationRoutes from './features/organizations/organizations.routes';
import adminRoutes from './features/admin/admin.routes';

export async function buildApp() {
  const app = Fastify({
    trustProxy: env.TRUST_PROXY_VALUE,
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? {
              target: 'pino-pretty',
              options: { colorize: true },
            }
          : undefined,
    },
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'blklight API', version: '1.0.0' },
      servers: [{ url: `http://localhost:${env.PORT}` }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  });

  await app.register(scalar, {
    routePrefix: '/docs',
    configuration: { title: 'blklight API' },
  });

  await app.register(cookie, { parseOptions: {} });

  await app.register(jwt, {
    secret: env.JWT_ACCESS_SECRET,
  });

  // origin must be an ARRAY: @fastify/cors only reflects the request origin
  // (required by credentials: true) when the option is an array/RegExp/function.
  // A comma-separated string would be treated as one literal origin, and an
  // array containing "*" collapses back to allow-all.
  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
  });

  // Route-level config.rateLimit inherits this errorResponseBuilder through the
  // plugin's mergeParams, so every 429 (global and per-route) is sent as a
  // RateLimitError and reaches setErrorHandler's AppError branch, yielding the
  // project's { data, error, message } envelope instead of a bare 500.
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) =>
      new RateLimitError(`Rate limit exceeded, retry in ${context.after}`),
  });

  await app.register(websocket, {
    options: { maxPayload: 16 * 1024 },
  });

  await app.register(oauth2, {
    name: 'githubOAuth2',
    scope: ['user:email'],
    credentials: {
      client: {
        id: env.GITHUB_CLIENT_ID,
        secret: env.GITHUB_CLIENT_SECRET,
      },
      auth: oauth2.GITHUB_CONFIGURATION,
    },
    callbackUri: `${env.OAUTH_REDIRECT_BASE_URL}/api/v1/auth/github/callback`,
  });

  await app.register(oauth2, {
    name: 'googleOAuth2',
    scope: ['profile', 'email'],
    credentials: {
      client: {
        id: env.GOOGLE_CLIENT_ID,
        secret: env.GOOGLE_CLIENT_SECRET,
      },
      auth: oauth2.GOOGLE_CONFIGURATION,
    },
    callbackUri: `${env.OAUTH_REDIRECT_BASE_URL}/api/v1/auth/google/callback`,
  });

  app.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
        message: 'Authentication failed',
      });
    }
  });

  app.addHook('onRequest', async (request) => {
    request.log.info({ url: request.url, method: request.method }, 'incoming request');
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info({ statusCode: reply.statusCode }, 'request completed');
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'request error');

    if (error instanceof ZodError) {
      const fields: Record<string, string> = {};
      for (const issue of error.issues) {
        const path = issue.path.join('.');
        if (!fields[path]) {
          fields[path] = issue.message;
        }
      }
      return reply.code(400).send({
        data: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          fields,
        },
        message: 'Validation failed',
      });
    }

    if (error instanceof ValidationError) {
      return reply.code(400).send({
        data: null,
        error: {
          code: error.code,
          message: error.message,
          fields: error.fields,
        },
        message: 'Validation failed',
      });
    }

    const knownError = error as Error & { code?: string; validation?: FastifySchemaValidationError[] };
    if (knownError.code === 'FST_ERR_VALIDATION') {
      const fields: Record<string, string> = {};
      for (const item of knownError.validation ?? []) {
        const missing = item.params['missingProperty'];
        const path = item.instancePath.replace(/^\//, '').replace(/\//g, '.');
        const key = typeof missing === 'string' && missing !== '' ? missing : path;
        if (key && !fields[key]) {
          fields[key] = item.message ?? 'Invalid field';
        }
      }
      return reply.code(400).send({
        data: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          ...(Object.keys(fields).length > 0 ? { fields } : {}),
        },
        message: 'Validation failed',
      });
    }

    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        data: null,
        error: { code: error.code, message: error.message },
        message: error.message,
      });
    }

    return reply.code(500).send({
      data: null,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      message: 'Internal server error',
    });
  });

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(oauthRoutes, { prefix: '/api/v1/auth' });
  await app.register(profileRoutes, { prefix: '/api/v1/profiles' });
  await app.register(documentRoutes, { prefix: '/api/v1/documents' });
  await app.register(styleTemplateRoutes, { prefix: '/api/v1/document-style-templates' });
  await app.register(tutorialExerciseRoutes, { prefix: '/api/v1' });
  await app.register(likesRoutes, { prefix: '/api/v1' });
  await app.register(bookmarksRoutes, { prefix: '/api/v1' });
  await app.register(categoryRoutes, { prefix: '/api/v1/categories' });
  await app.register(tagRoutes, { prefix: '/api/v1/tags' });
  await app.register(bookRoutes, { prefix: '/api/v1/books' });
  await app.register(highlightRoutes, { prefix: '/api/v1' });
  await app.register(documentHighlightRoutes, { prefix: '/api/v1/documents' });
  await app.register(workspaceRoutes, { prefix: '/api/v1' });
  await app.register(noteRoutes, { prefix: '/api/v1/notes' });
  await app.register(journalRoutes, { prefix: '/api/v1/journals' });
  await app.register(followRoutes, { prefix: '/api/v1' });
  await app.register(platformAppsRoutes, { prefix: '/api/v1' });
  await app.register(canvasRoutes, { prefix: '/api/v1' });
  await app.register(memoryRoutes, { prefix: '/api/v1' });
  await app.register(chatRoutes, { prefix: '/api/v1' });
  await app.register(organizationRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1' });

  const startTime = Date.now();
  app.get('/health', async (_request, _reply) => ({
    data: {
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    },
    error: null,
    message: 'Healthy',
  }));

  return app;
}

export type { FastifyRequest, FastifyReply };
