import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createBookSchema,
  updateBookSchema,
  addChapterSchema,
  updateChapterSchema,
  reorderChaptersSchema,
  updateTocSchema,
  bookFeedQuerySchema,
} from './books.zod';
import {
  createBook,
  updateBook,
  publishBook,
  softDeleteBook,
  getMyBooks,
  addChapter,
  updateChapter,
  removeChapter,
  reorderChapters,
  updateToc,
  getPublicBookFeed,
  getPublicBook,
  updateProgress,
} from './books.service';
import { profiles } from '../profiles/profiles.schema';
import { db } from '../../db/index';
import { eq } from 'drizzle-orm';
import { resolveProfileIdFromUserId } from '../../utils/profile';

export default async function bookRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
  });

  app.get('/', {
    schema: {
      summary: 'Get public book feed (requires auth)',
      tags: ['books'],
      querystring: {
        type: 'object',
        properties: {
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          category: { type: 'string' },
          tag: { type: 'string' },
          q: { type: 'string', minLength: 1, maxLength: 100 },
          sort: { type: 'string', enum: ['recent', 'popular'], default: 'recent' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'object', additionalProperties: true },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          properties: {
            data: { type: 'null' },
            error: { type: 'object', additionalProperties: true },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Querystring: { cursor?: string; limit?: number; category?: string; tag?: string; q?: string; sort?: string }
  }>, reply: FastifyReply) => {
    const parsed = bookFeedQuerySchema.parse(request.query);
    const result = await getPublicBookFeed(parsed);

    reply.send({
      data: result,
      error: null,
      message: 'Books retrieved',
    });
  });

  app.get('/:username/:slug', {
    schema: {
      summary: 'Get a public book by username and slug',
      tags: ['books'],
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
            data: { type: 'object', additionalProperties: true },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          properties: {
            data: { type: 'null' },
            error: { type: 'object', additionalProperties: true },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { username: string; slug: string } }>, reply: FastifyReply) => {
    const { username, slug } = request.params;
    const { userId } = request.user;

    const profileId = await resolveProfileIdFromUserId(userId);
    const book = await getPublicBook(username, slug, profileId);

    reply.send({
      data: book,
      error: null,
      message: 'Book retrieved',
    });
  });

  app.patch('/:id/progress/:chapterId', {
    schema: {
      summary: 'Update reading progress on a chapter',
      tags: ['books'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          chapterId: { type: 'string' },
        },
        required: ['id', 'chapterId'],
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
  }, async (request: FastifyRequest<{ Params: { id: string; chapterId: string } }>, reply: FastifyReply) => {
    const { userId } = request.user;
    const { id, chapterId } = request.params;

    const profileId = await resolveProfileIdFromUserId(userId);
    await updateProgress(profileId, id, chapterId);

    reply.send({
      data: null,
      error: null,
      message: 'Progress updated',
    });
  });

  app.get('/me', {
    schema: {
      summary: 'Get my books',
      tags: ['books'],
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array' },
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
    const books = await getMyBooks(authorId);

    reply.send({
      data: books,
      error: null,
      message: 'Books retrieved',
    });
  });

  app.post('/', {
    schema: {
      summary: 'Create a new book',
      tags: ['books'],
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 500 },
          coverImageUrl: { type: 'string', format: 'uri' },
          slug: { type: 'string', pattern: '^[a-z0-9-]+$' },
          categoryId: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            data: { type: 'object', additionalProperties: true },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          properties: {
            data: { type: 'null' },
            error: { type: 'object', additionalProperties: true },
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
    const parsed = createBookSchema.parse(request.body);
    const book = await createBook(authorId, parsed);

    reply.code(201).send({
      data: book,
      error: null,
      message: 'Book created',
    });
  });

  app.patch('/:id', {
    schema: {
      summary: 'Update a book',
      tags: ['books'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 500 },
          coverImageUrl: { type: 'string', format: 'uri' },
          slug: { type: 'string', pattern: '^[a-z0-9-]+$' },
          categoryId: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'object', additionalProperties: true },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          properties: {
            data: { type: 'null' },
            error: { type: 'object', additionalProperties: true },
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
    const parsed = updateBookSchema.parse(request.body);
    const book = await updateBook(authorId, id, parsed);

    reply.send({
      data: book,
      error: null,
      message: 'Book updated',
    });
  });

  app.patch('/:id/publish', {
    schema: {
      summary: 'Publish a book',
      tags: ['books'],
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
            data: { type: 'object', additionalProperties: true },
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
    const book = await publishBook(authorId, id);

    reply.send({
      data: book,
      error: null,
      message: 'Book published',
    });
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete a book',
      tags: ['books'],
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
    await softDeleteBook(authorId, id);

    reply.send({
      data: null,
      error: null,
      message: 'Book deleted',
    });
  });

  app.post('/:id/chapters', {
    schema: {
      summary: 'Add a chapter to a book',
      tags: ['books'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: {
        type: 'object',
        required: ['documentId'],
        properties: {
          documentId: { type: 'string' },
          position: { type: 'integer', minimum: 1 },
          introText: { type: 'string', maxLength: 1000 },
          outroText: { type: 'string', maxLength: 1000 },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            data: { type: 'object', additionalProperties: true },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          properties: {
            data: { type: 'null' },
            error: { type: 'object', additionalProperties: true },
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
    const parsed = addChapterSchema.parse(request.body);
    const chapter = await addChapter(authorId, id, parsed);

    reply.code(201).send({
      data: chapter,
      error: null,
      message: 'Chapter added',
    });
  });

  app.patch('/:id/chapters/:chapterId', {
    schema: {
      summary: 'Update a chapter',
      tags: ['books'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          chapterId: { type: 'string' },
        },
        required: ['id', 'chapterId'],
      },
      body: {
        type: 'object',
        properties: {
          introText: { type: 'string', maxLength: 1000 },
          outroText: { type: 'string', maxLength: 1000 },
          position: { type: 'integer', minimum: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'object', additionalProperties: true },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          properties: {
            data: { type: 'null' },
            error: { type: 'object', additionalProperties: true },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string; chapterId: string } }>, reply: FastifyReply) => {
    const { userId } = request.user;
    const { id, chapterId } = request.params;

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
    const parsed = updateChapterSchema.parse(request.body);
    const chapter = await updateChapter(authorId, chapterId, parsed);

    reply.send({
      data: chapter,
      error: null,
      message: 'Chapter updated',
    });
  });

  app.delete('/:id/chapters/:chapterId', {
    schema: {
      summary: 'Remove a chapter from a book',
      tags: ['books'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          chapterId: { type: 'string' },
        },
        required: ['id', 'chapterId'],
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
  }, async (request: FastifyRequest<{ Params: { id: string; chapterId: string } }>, reply: FastifyReply) => {
    const { userId } = request.user;
    const { id, chapterId } = request.params;

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
    await removeChapter(authorId, chapterId);

    reply.send({
      data: null,
      error: null,
      message: 'Chapter removed',
    });
  });

  app.patch('/:id/chapters/reorder', {
    schema: {
      summary: 'Reorder chapters in a book',
      tags: ['books'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: {
        type: 'object',
        required: ['chapters'],
        properties: {
          chapters: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                position: { type: 'integer', minimum: 1 },
              },
            },
          },
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
        400: {
          type: 'object',
          properties: {
            data: { type: 'null' },
            error: { type: 'object', additionalProperties: true },
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
    const parsed = reorderChaptersSchema.parse(request.body);
    await reorderChapters(authorId, id, parsed);

    reply.send({
      data: null,
      error: null,
      message: 'Chapters reordered',
    });
  });

  app.patch('/:id/toc', {
    schema: {
      summary: 'Update table of contents',
      tags: ['books'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: {
        type: 'object',
        required: ['toc'],
        properties: {
          toc: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                chapterId: { type: 'string' },
                title: { type: 'string' },
                headings: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      level: { type: 'number' },
                      text: { type: 'string' },
                      anchor: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'object', additionalProperties: true },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          properties: {
            data: { type: 'null' },
            error: { type: 'object', additionalProperties: true },
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
    const parsed = updateTocSchema.parse(request.body);
    const book = await updateToc(authorId, id, parsed);

    reply.send({
      data: book,
      error: null,
      message: 'TOC updated',
    });
  });
}
