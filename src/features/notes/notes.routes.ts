import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createNoteSchema, updateNoteSchema, noteQuerySchema } from './notes.zod';
import {
  createNote,
  updateNote,
  deleteNote,
  getMyNotes,
  getNoteById,
} from './notes.service';

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    canvasId: { type: 'string' },
    title: { type: ['string', 'null'] },
    content: { type: 'string' },
    type: { type: 'string' },
    language: { type: ['string', 'null'] },
    color: { type: 'string' },
    deletedAt: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
};

export default async function noteRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
  });

  app.post('/', {
    schema: {
      summary: 'Create a note',
      tags: ['notes'],
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          title: { type: 'string', maxLength: 200 },
          content: { type: 'string', minLength: 1, maxLength: 10000 },
          type: { type: 'string' },
          language: { type: 'string', maxLength: 50 },
          color: { type: 'string' },
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
    const parsed = createNoteSchema.safeParse(request.body);

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

    const note = await createNote(userId, parsed.data);

    reply.code(201).send({
      data: note,
      error: null,
      message: 'Note created',
    });
  });

  app.get('/', {
    schema: {
      summary: 'Get my notes',
      tags: ['notes'],
      querystring: {
        type: 'object',
        properties: {
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          type: { type: 'string' },
          color: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                items: { type: 'array', items: NOTE_SCHEMA },
                nextCursor: { type: ['string', 'null'] },
                total: { type: 'number' },
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
  }, async (request: FastifyRequest<{
    Querystring: { cursor?: string; limit?: number; type?: string; color?: string }
  }>, reply: FastifyReply) => {
    const { userId } = request.user;
    const parsed = noteQuerySchema.safeParse(request.query);

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

    const result = await getMyNotes(userId, parsed.data);

    reply.send({
      data: result,
      error: null,
      message: 'Notes retrieved',
    });
  });

  app.get('/:id', {
    schema: {
      summary: 'Get a note by ID',
      tags: ['notes'],
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

    const note = await getNoteById(userId, id);

    reply.send({
      data: note,
      error: null,
      message: 'Note retrieved',
    });
  });

  app.patch('/:id', {
    schema: {
      summary: 'Update a note',
      tags: ['notes'],
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
          title: { type: 'string', maxLength: 200 },
          content: { type: 'string', minLength: 1, maxLength: 10000 },
          type: { type: 'string' },
          language: { type: 'string', maxLength: 50 },
          color: { type: 'string' },
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
    const parsed = updateNoteSchema.safeParse(request.body);

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

    const note = await updateNote(userId, id, parsed.data);

    reply.send({
      data: note,
      error: null,
      message: 'Note updated',
    });
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete a note',
      tags: ['notes'],
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

    await deleteNote(userId, id);

    reply.send({
      data: null,
      error: null,
      message: 'Note deleted',
    });
  });
}
