import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHighlightSchema } from './highlights.zod';
import { createHighlight, getDocumentHighlights } from './highlights.service';
import { resolveProfileIdFromUserId } from '../../utils/profile';

export default async function documentHighlightRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
  });

  app.post('/:id/highlights', {
    schema: {
      summary: 'Create a highlight on a document',
      tags: ['highlights'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: {
        type: 'object',
        required: ['selection'],
        properties: {
          selection: {
            type: 'object',
            required: ['text', 'color', 'position'],
            properties: {
              text: { type: 'string', minLength: 1, maxLength: 2000 },
              color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
              position: {
                type: 'object',
                required: ['nodeIndex', 'offsetStart', 'offsetEnd'],
                properties: {
                  nodeIndex: { type: 'number', minimum: 0 },
                  offsetStart: { type: 'number', minimum: 0 },
                  offsetEnd: { type: 'number', minimum: 1 },
                },
              },
            },
          },
          annotation: { type: 'object', nullable: true },
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

    const parsed = createHighlightSchema.parse({
      documentId: id,
      ...(request.body as object),
    });
    const profileId = await resolveProfileIdFromUserId(userId);

    const highlight = await createHighlight(profileId, parsed);

    reply.code(201).send({
      data: highlight,
      error: null,
      message: 'Highlight created',
    });
  });

  app.get('/:id/highlights/me', {
    schema: {
      summary: 'Get my highlights on a document (reading order)',
      tags: ['highlights'],
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
            data: { type: 'array' },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { userId } = request.user;
    const { id } = request.params;

    const profileId = await resolveProfileIdFromUserId(userId);

    const highlights = await getDocumentHighlights(profileId, id);

    reply.send({
      data: highlights,
      error: null,
      message: 'Highlights retrieved',
    });
  });
}
