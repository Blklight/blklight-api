import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getMyCanvas, updatePositions } from './canvas.service';
import { updatePositionsSchema } from './canvas.zod';

export default async function canvasRoutes(app: FastifyInstance) {
  app.get('/canvas/me', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: "Get user's canvas with all notes and positions",
      tags: ['canvas'],
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
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user.userId;

    try {
      const canvasData = await getMyCanvas(userId);

      reply.send({
        data: canvasData,
        error: null,
        message: 'Canvas retrieved successfully',
      });
    } catch (err) {
      return reply.code(404).send({
        data: null,
        error: { code: 'NOT_FOUND', message: (err as Error).message },
        message: 'Canvas not found',
      });
    }
  });

  app.patch('/canvas/me/positions', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Batch update note positions on canvas',
      tags: ['canvas'],
      body: {
        type: 'object',
        properties: {
          positions: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                noteId: { type: 'string', minLength: 1 },
                x: { type: 'number' },
                y: { type: 'number' },
                w: { type: 'number' },
                h: { type: 'number' },
                z: { type: 'number' },
              },
              required: ['noteId', 'x', 'y'],
              additionalProperties: false,
            },
          },
        },
        required: ['positions'],
        additionalProperties: false,
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
    const userId = request.user.userId;
    const parsed = updatePositionsSchema.safeParse(request.body);

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

    try {
      await updatePositions(userId, parsed.data.positions);

      reply.send({
        data: null,
        error: null,
        message: 'Positions updated successfully',
      });
    } catch (err) {
      return reply.code(400).send({
        data: null,
        error: { code: 'VALIDATION_ERROR', message: (err as Error).message },
        message: 'Failed to update positions',
      });
    }
  });
}