import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getPopularTags } from './tags.service';

const popularTagsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20).optional(),
});

export default async function tagRoutes(app: FastifyInstance) {
  app.get('/popular', {
    schema: {
      summary: 'Get popular tags sorted by usage',
      tags: ['tags'],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  slug: { type: 'string' },
                  documentCount: { type: 'number' },
                },
              },
            },
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
    const parsed = popularTagsQuerySchema.safeParse(request.query);

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

    const tags = await getPopularTags(parsed.data.limit ?? 20);

    reply.send({
      data: tags,
      error: null,
      message: 'Tags retrieved',
    });
  });
}
