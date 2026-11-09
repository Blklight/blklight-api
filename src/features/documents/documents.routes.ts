import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { toJsonSchema } from '../../utils/json-schema';
import { createDocumentSchema, updateDocumentSchema, feedQuerySchema } from './documents.zod';
import {
  createDocument,
  updateDocument,
  publishDocument,
  softDeleteDocument,
  getMyDocuments,
  getMyDocumentById,
  getPublicFeed,
  getPublicDocument,
} from './documents.service';
import { profiles } from '../profiles/profiles.schema';
import { db } from '../../db/index';
import { eq } from 'drizzle-orm';
import { resolveProfileIdFromUserId } from '../../utils/profile';
import { env } from '../../config/env';

const AUTHOR_SCHEMA = {
  type: 'object',
  properties: {
    username: { type: 'string' },
    displayName: { type: ['string', 'null'] },
    avatarUrl: { type: ['string', 'null'] },
  },
};

const CATEGORY_REF_SCHEMA = {
  type: ['object', 'null'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
  },
};

const TAG_REF_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
  },
};

const STYLE_SCHEMA = {
  type: 'object',
  properties: {
    typography: { type: 'string' },
    paperStyle: { type: ['object', 'null'], additionalProperties: true },
    paperTexture: { type: ['object', 'null'], additionalProperties: true },
    coverSettings: { type: ['object', 'null'], additionalProperties: true },
    documentHeader: { type: ['object', 'null'], additionalProperties: true },
    documentFooter: { type: ['object', 'null'], additionalProperties: true },
    documentSignature: { type: ['object', 'null'], additionalProperties: true },
  },
};

// additionalProperties: false also strips userHash from documents signed
// before it was dropped from Authorship (it is still stored in their jsonb).
const AUTHORSHIP_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    authorName: { type: 'string' },
    username: { type: 'string' },
    documentHash: { type: 'string' },
    publicIdentifier: { type: 'string' },
    hmac: { type: 'string' },
    signedAt: { type: 'string' },
  },
};

const ORGANIZATION_REF_SCHEMA = {
  type: ['object', 'null'],
  properties: {
    id: { type: 'string' },
    orgname: { type: 'string' },
    name: { type: 'string' },
  },
};

export const DOCUMENT_CARD_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    abstract: { type: ['string', 'null'] },
    coverImageUrl: { type: ['string', 'null'] },
    slug: { type: 'string' },
    publishedAt: { type: 'string' },
    typeName: { type: 'string' },
    author: AUTHOR_SCHEMA,
    authorship: {
      type: 'object',
      properties: {
        publicIdentifier: { type: 'string' },
      },
    },
    likesCount: { type: 'number' },
    category: CATEGORY_REF_SCHEMA,
    tags: { type: 'array', items: TAG_REF_SCHEMA },
    organization: ORGANIZATION_REF_SCHEMA,
  },
};

const DOCUMENT_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    abstract: { type: ['string', 'null'] },
    status: { type: 'string' },
    typeName: { type: 'string' },
    slug: { type: 'string' },
    coverImageUrl: { type: ['string', 'null'] },
    authorship: AUTHORSHIP_SCHEMA,
    publishedAt: { type: ['string', 'null'] },
    updatedAt: { type: 'string' },
    createdAt: { type: 'string' },
    organization: ORGANIZATION_REF_SCHEMA,
  },
};

const DOCUMENT_FULL_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    abstract: { type: ['string', 'null'] },
    content: { type: ['object', 'null'], additionalProperties: true },
    coverImageUrl: { type: ['string', 'null'] },
    slug: { type: 'string' },
    publishedAt: { type: 'string' },
    typeName: { type: 'string' },
    author: AUTHOR_SCHEMA,
    style: STYLE_SCHEMA,
    authorship: AUTHORSHIP_SCHEMA,
    likes: {
      type: 'object',
      properties: {
        likesCount: { type: 'number' },
        likedByMe: { type: ['boolean', 'null'] },
      },
    },
    category: CATEGORY_REF_SCHEMA,
    tags: { type: 'array', items: TAG_REF_SCHEMA },
    exercises: { type: 'array', items: { type: 'object', additionalProperties: true } },
    organization: ORGANIZATION_REF_SCHEMA,
  },
};

const DOCUMENT_WITH_STYLE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    authorId: { type: 'string' },
    typeId: { type: 'string' },
    typeName: { type: 'string' },
    status: { type: 'string' },
    title: { type: 'string' },
    abstract: { type: ['string', 'null'] },
    content: { type: ['object', 'null'], additionalProperties: true },
    coverImageUrl: { type: ['string', 'null'] },
    slug: { type: 'string' },
    authorship: AUTHORSHIP_SCHEMA,
    publishedAt: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    style: STYLE_SCHEMA,
    organization: ORGANIZATION_REF_SCHEMA,
  },
};

const MY_DOCUMENT_SCHEMA = {
  type: 'object',
  properties: {
    ...DOCUMENT_WITH_STYLE_SCHEMA.properties,
    category: CATEGORY_REF_SCHEMA,
    tags: { type: 'array', items: TAG_REF_SCHEMA },
  },
};

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

export default async function documentRoutes(app: FastifyInstance) {
  app.get('/', {
    schema: {
      summary: 'Get public document feed',
      tags: ['documents'],
      querystring: toJsonSchema(feedQuerySchema),
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                items: {
                  type: 'array',
                  items: DOCUMENT_CARD_SCHEMA,
                },
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
  }, async (request: FastifyRequest<{ Querystring: { cursor?: string; limit?: number; type?: string; author?: string; q?: string; sort?: string; category?: string; tag?: string; organization?: string } }>, reply: FastifyReply) => {
    const parsed = feedQuerySchema.parse(request.query);
    // Auth is optional here: anonymous visitors get the feed without documents
    // from private authors, while an accepted follower of a private author
    // still sees them. Same try/catch pattern used by /:username/:slug.
    let profileId: string | undefined;
    try {
      await request.jwtVerify();
      profileId = await resolveProfileIdFromUserId(request.user.userId);
    } catch {
      profileId = undefined;
    }

    const result = await getPublicFeed(parsed, profileId);

    reply.send({
      data: result,
      error: null,
      message: 'Feed retrieved',
    });
  });

  app.get('/:username/:slug', {
    schema: {
      summary: 'Get a public document by username and slug',
      tags: ['documents'],
      params: {
        type: 'object',
        properties: {
          username: { type: 'string' },
          slug: { type: 'string' },
        },
        required: ['username', 'slug'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: DOCUMENT_FULL_SCHEMA,
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { username: string; slug: string } }>, reply: FastifyReply) => {
    const { username, slug } = request.params;

    let profileId: string | undefined;
    try {
      await request.jwtVerify();
      profileId = await resolveProfileIdFromUserId(request.user.userId);
    } catch {
      profileId = undefined;
    }

    const document = await getPublicDocument(username, slug, profileId);

    reply.send({
      data: document,
      error: null,
      message: 'Document retrieved',
    });
  });

  await app.register(async function protectedDocuments(app: FastifyInstance) {
    app.addHook('preHandler', async (request, reply) => {
      await app.authenticate(request, reply);
    });

    app.get('/me', {
      schema: {
        summary: 'Get my documents',
        tags: ['documents'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: DOCUMENT_SUMMARY_SCHEMA,
              },
              error: { type: 'null' },
              message: { type: 'string' },
            },
          },
        },
      },
    }, async (request: FastifyRequest<{ Querystring: { limit?: number; offset?: number } }>, reply: FastifyReply) => {
      const { userId } = request.user;
      const { limit = 20, offset = 0 } = request.query;

      const profileResult = await db
        .select()
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);

      if (profileResult.length === 0) {
        return reply.code(404).send({
          data: null,
          error: { code: 'NOT_FOUND', message: 'Profile not found' },
          message: 'Profile not found',
        });
      }

      const authorId = profileResult[0]!.id;
      const documents = await getMyDocuments(authorId, limit, offset);

      reply.send({
        data: documents,
        error: null,
        message: 'Documents retrieved',
      });
    });

    app.get('/:id', {
      schema: {
        summary: 'Get one of my documents by ID',
        description: 'Returns a full document owned by the caller (draft, published or archived), including style, category and tags. Used to reopen a document in the editor.',
        tags: ['documents'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: MY_DOCUMENT_SCHEMA,
              error: { type: 'null' },
              message: { type: 'string' },
            },
          },
        },
      },
    }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { userId } = request.user;
      const { id } = request.params;

      const authorId = await resolveProfileIdFromUserId(userId);
      const document = await getMyDocumentById(authorId, id);

      reply.send({
        data: document,
        error: null,
        message: 'Document retrieved',
      });
    });

    app.post('/', {
      config: {
        // hook: 'preHandler' runs after the scope's authenticate hook, so the
        // keyGenerator can key by the authenticated user. Fallback to IP keeps
        // unauthenticated requests (rejected later anyway) from sharing a bucket.
        rateLimit: {
          max: env.RATE_LIMIT_DOCS_CREATE_MAX,
          timeWindow: '1 minute',
          hook: 'preHandler',
          keyGenerator: (request) => request.user?.userId ?? request.ip,
        },
      },
      schema: {
        summary: 'Create a new document',
        tags: ['documents'],
        body: toJsonSchema(createDocumentSchema),
        response: {
          201: {
            type: 'object',
            properties: {
              data: DOCUMENT_WITH_STYLE_SCHEMA,
              error: { type: 'null' },
              message: { type: 'string' },
            },
          },
        },
      },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = request.user;

      const profileResult = await db
        .select()
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);

      if (profileResult.length === 0) {
        return reply.code(404).send({
          data: null,
          error: { code: 'NOT_FOUND', message: 'Profile not found' },
          message: 'Profile not found',
        });
      }

      const authorId = profileResult[0]!.id;
      const parsed = createDocumentSchema.parse(request.body);
      const document = await createDocument(authorId, parsed);

      reply.code(201).send({
        data: document,
        error: null,
        message: 'Document created',
      });
    });

    app.patch('/:id', {
      schema: {
        summary: 'Update a document',
        tags: ['documents'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        body: toJsonSchema(updateDocumentSchema),
        response: {
          200: {
            type: 'object',
            properties: {
              data: DOCUMENT_WITH_STYLE_SCHEMA,
              error: { type: 'null' },
              message: { type: 'string' },
            },
          },
        },
      },
    }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { userId } = request.user;
      const { id } = request.params;

      const profileResult = await db
        .select()
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);

      if (profileResult.length === 0) {
        return reply.code(404).send({
          data: null,
          error: { code: 'NOT_FOUND', message: 'Profile not found' },
          message: 'Profile not found',
        });
      }

      const authorId = profileResult[0]!.id;
      const parsed = updateDocumentSchema.parse(request.body);
      const document = await updateDocument(authorId, id, parsed);

      reply.send({
        data: document,
        error: null,
        message: 'Document updated',
      });
    });

    app.patch('/:id/publish', {
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_DOCS_PUBLISH_MAX,
          timeWindow: '1 minute',
          hook: 'preHandler',
          keyGenerator: (request) => request.user?.userId ?? request.ip,
        },
      },
      schema: {
        summary: 'Publish a document',
        tags: ['documents'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: DOCUMENT_WITH_STYLE_SCHEMA,
              error: { type: 'null' },
              message: { type: 'string' },
            },
          },
        },
      },
    }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { userId } = request.user;
      const { id } = request.params;

      const profileResult = await db
        .select()
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);

      if (profileResult.length === 0) {
        return reply.code(404).send({
          data: null,
          error: { code: 'NOT_FOUND', message: 'Profile not found' },
          message: 'Profile not found',
        });
      }

      const authorId = profileResult[0]!.id;
      const document = await publishDocument(authorId, id);

      reply.send({
        data: document,
        error: null,
        message: 'Document published',
      });
    });

    app.delete('/:id', {
      schema: {
        summary: 'Delete a document',
        tags: ['documents'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
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
    }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { userId } = request.user;
      const { id } = request.params;

      const profileResult = await db
        .select()
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);

      if (profileResult.length === 0) {
        return reply.code(404).send({
          data: null,
          error: { code: 'NOT_FOUND', message: 'Profile not found' },
          message: 'Profile not found',
        });
      }

      const authorId = profileResult[0]!.id;
      await softDeleteDocument(authorId, id);

      reply.send({
        data: null,
        error: null,
        message: 'Document deleted',
      });
    });
  });
}