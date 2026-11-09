import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { toJsonSchema } from '../../utils/json-schema';
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
      querystring: toJsonSchema(popularTagsQuerySchema),
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
    const parsed = popularTagsQuerySchema.parse(request.query);
    const tags = await getPopularTags(parsed.limit ?? 20);

    reply.send({
      data: tags,
      error: null,
      message: 'Tags retrieved',
    });
  });
}
