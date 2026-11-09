import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { updateProfileSchema } from './profiles.zod';
import { getPublicProfile, getOwnProfile, updateProfile, deleteAccount } from './profiles.service';
import { getAuthorPublicDocuments } from '../documents/documents.service';
import { authorFeedQuerySchema } from '../documents/documents.zod';
import { env } from '../../config/env';
import {
  REFRESH_COOKIE_NAME,
  buildRefreshCookieClearOptions,
} from '../../config/cookies';
import { resolveProfileIdFromUserId } from '../../utils/profile';

interface JwtPayload {
  userId: string;
  email: string;
  role: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

export default async function profileRoutes(app: FastifyInstance) {
  app.get('/:username', {
    schema: {
      summary: 'Get public profile by username',
      tags: ['profiles'],
      params: {
        type: 'object',
        properties: {
          username: { type: 'string' },
        },
        required: ['username'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                username: { type: 'string' },
                displayName: { type: ['string', 'null'] },
                bio: { type: ['string', 'null'] },
                bioPrivate: { type: ['string', 'null'] },
                avatarUrl: { type: ['string', 'null'] },
                socialLinks: { type: ['object', 'null'], additionalProperties: true },
                createdAt: { type: 'string' },
                isPrivate: { type: 'boolean' },
                isFollowing: { type: ['boolean', 'null'] },
                followStatus: { type: ['string', 'null'] },
              },
            },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { username: string } }>, reply: FastifyReply) => {
    const { username } = request.params;
    let viewerUserId: string | undefined;

    try {
      await request.jwtVerify();
      viewerUserId = request.user.userId;
    } catch {
      viewerUserId = undefined;
    }

    const profile = await getPublicProfile(username, viewerUserId);
    reply.send({
      data: {
        ...profile,
        createdAt: profile.createdAt.toISOString(),
      },
      error: null,
      message: 'Profile retrieved',
    });
  });

  app.get('/:username/documents', {
    schema: {
      summary: 'Get published documents by a specific author',
      tags: ['profiles'],
      params: {
        type: 'object',
        properties: {
          username: { type: 'string' },
        },
        required: ['username'],
      },
      querystring: {
        type: 'object',
        properties: {
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          type: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                items: { type: 'array' },
                nextCursor: { type: ['string', 'null'] },
                total: { type: 'number' },
              },
            },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { username: string }; Querystring: { cursor?: string; limit?: number; type?: string } }>, reply: FastifyReply) => {
    const { username } = request.params;
    const parsed = authorFeedQuerySchema.parse(request.query);
    // Optional auth for the same reason as GET /:username — a private
    // author's documents are only listed for the author or accepted followers.
    let viewerProfileId: string | undefined;
    try {
      await request.jwtVerify();
      viewerProfileId = await resolveProfileIdFromUserId(request.user.userId);
    } catch {
      viewerProfileId = undefined;
    }

    const result = await getAuthorPublicDocuments(username, parsed, viewerProfileId);

    reply.send({
      data: result,
      error: null,
      message: 'Author documents retrieved',
    });
  });

  app.get('/me', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Get own profile',
      tags: ['profiles'],
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                username: { type: 'string' },
                displayName: { type: ['string', 'null'] },
                bio: { type: ['string', 'null'] },
                bioPrivate: { type: ['string', 'null'] },
                avatarUrl: { type: ['string', 'null'] },
                socialLinks: { type: ['object', 'null'], additionalProperties: true },
                createdAt: { type: 'string' },
                isPrivate: { type: 'boolean' },
                email: { type: 'string' },
                emailVerified: { type: 'boolean' },
                role: { type: 'string' },
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
    const profile = await getOwnProfile(userId);
    reply.send({
      data: {
        ...profile,
        createdAt: profile.createdAt.toISOString(),
      },
      error: null,
      message: 'Profile retrieved',
    });
  });

  app.patch('/me', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Update own profile',
      tags: ['profiles'],
      body: {
        type: 'object',
        properties: {
          username: { type: 'string', minLength: 3, maxLength: 30 },
          displayName: { type: ['string', 'null'] },
          bio: { type: ['string', 'null'], maxLength: 300 },
          bioPrivate: { type: ['string', 'null'], maxLength: 150 },
          avatarUrl: { type: ['string', 'null'] },
          isPrivate: { type: 'boolean' },
          socialLinks: {
            type: ['object', 'null'],
            properties: {
              twitter: { type: 'string' },
              github: { type: 'string' },
              linkedin: { type: 'string' },
              website: { type: 'string' },
            },
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                username: { type: 'string' },
                displayName: { type: ['string', 'null'] },
                bio: { type: ['string', 'null'] },
                bioPrivate: { type: ['string', 'null'] },
                avatarUrl: { type: ['string', 'null'] },
                socialLinks: { type: ['object', 'null'], additionalProperties: true },
                createdAt: { type: 'string' },
                isPrivate: { type: 'boolean' },
                email: { type: 'string' },
                emailVerified: { type: 'boolean' },
                role: { type: 'string' },
              },
            },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = updateProfileSchema.parse(request.body);
    const userId = request.user.userId;
    const profile = await updateProfile(userId, parsed);
    reply.send({
      data: {
        ...profile,
        createdAt: profile.createdAt.toISOString(),
      },
      error: null,
      message: 'Profile updated',
    });
  });

  app.delete('/me', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Delete own account',
      tags: ['profiles'],
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
    await deleteAccount(userId);
    reply.clearCookie(REFRESH_COOKIE_NAME, buildRefreshCookieClearOptions()).send({
      data: null,
      error: null,
      message: 'Account deleted',
    });
  });
}
