import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { semanticSearch, getRelated, getDigest } from './memory.service';
import { searchQuerySchema, relatedParamsSchema } from './memory.zod';
import { requireFeature } from '../../config/features';

export default async function memoryRoutes(app: FastifyInstance) {
  app.get('/memory/search', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Semantic search across indexed content',
      tags: ['memory'],
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string', minLength: 1 },
          limit: { type: 'string' },
        },
        required: ['q'],
        additionalProperties: false,
      },
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
    requireFeature('memory');

    const parsed = searchQuerySchema.parse(request.query);
    const userId = request.user.userId;
    const results = await semanticSearch(userId, parsed.q, parsed.limit);

    reply.send({
      data: results,
      error: null,
      message: 'Search completed successfully',
    });
  });

  app.get('/memory/related/:sourceType/:sourceId', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Get related items for a specific content piece',
      tags: ['memory'],
      params: {
        type: 'object',
        properties: {
          sourceType: {
            type: 'string',
            enum: ['note', 'document', 'journal_highlight', 'book_chapter'],
          },
          sourceId: { type: 'string', minLength: 1 },
        },
        required: ['sourceType', 'sourceId'],
        additionalProperties: false,
      },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 5 },
        },
      },
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
    requireFeature('memory');

    const paramsParsed = relatedParamsSchema.parse(request.params);
    const userId = request.user.userId;
    const limit = (request.query as { limit?: number }).limit ?? 5;

    const results = await getRelated(userId, paramsParsed.sourceType, paramsParsed.sourceId, limit);

    reply.send({
      data: results,
      error: null,
      message: 'Related items retrieved successfully',
    });
  });

  app.get('/memory/digest', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Get weekly connections digest',
      tags: ['memory'],
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
    requireFeature('memory');

    const userId = request.user.userId;
    const results = await getDigest(userId);

    reply.send({
      data: results,
      error: null,
      message: 'Digest retrieved successfully',
    });
  });
}