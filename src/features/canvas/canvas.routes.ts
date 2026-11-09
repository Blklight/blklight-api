import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { toJsonSchema } from '../../utils/json-schema';
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
      body: toJsonSchema(updatePositionsSchema),
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
    const parsed = updatePositionsSchema.parse(request.body);
    try {
      await updatePositions(userId, parsed.positions);

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