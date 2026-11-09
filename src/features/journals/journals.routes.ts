import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { toJsonSchema } from '../../utils/json-schema';
import {
  CreateJournalSchema,
  UpdateJournalSchema,
  AddHighlightSchema,
  ReorderHighlightsSchema,
} from './journals.zod';
import {
  createJournal,
  updateJournal,
  deleteJournal,
  getMyJournals,
  getJournalById,
  addHighlightToJournal,
  removeHighlightFromJournal,
  reorderHighlights,
} from './journals.service';
import { resolveProfileIdFromUserId } from '../../utils/profile';

export default async function journalRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
  });

  app.post('/', {
    schema: {
      summary: 'Create a journal',
      tags: ['journals'],
      body: toJsonSchema(CreateJournalSchema),
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
    const parsed = CreateJournalSchema.parse(request.body);
    const journal = await createJournal(userId, parsed);

    reply.code(201).send({
      data: journal,
      error: null,
      message: 'Journal created',
    });
  });

  app.get('/', {
    schema: {
      summary: 'Get my journals',
      tags: ['journals'],
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

    const journals = await getMyJournals(userId);

    reply.send({
      data: journals,
      error: null,
      message: 'Journals retrieved',
    });
  });

  app.get('/:id', {
    schema: {
      summary: 'Get a journal by ID',
      tags: ['journals'],
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

    const journal = await getJournalById(userId, id);

    reply.send({
      data: journal,
      error: null,
      message: 'Journal retrieved',
    });
  });

  app.patch('/:id', {
    schema: {
      summary: 'Update a journal',
      tags: ['journals'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: toJsonSchema(UpdateJournalSchema),
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
    const parsed = UpdateJournalSchema.parse(request.body);
    const journal = await updateJournal(userId, id, parsed);

    reply.send({
      data: journal,
      error: null,
      message: 'Journal updated',
    });
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete a journal',
      tags: ['journals'],
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

    await deleteJournal(userId, id);

    reply.send({
      data: null,
      error: null,
      message: 'Journal deleted',
    });
  });

  app.post('/:id/highlights', {
    schema: {
      summary: 'Add a highlight to a journal',
      tags: ['journals'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: toJsonSchema(AddHighlightSchema),
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
    const parsed = AddHighlightSchema.parse(request.body);
    const profileId = await resolveProfileIdFromUserId(userId);
    const journalHighlight = await addHighlightToJournal(profileId, id, parsed);

    reply.code(201).send({
      data: journalHighlight,
      error: null,
      message: 'Highlight added to journal',
    });
  });

  app.delete('/:id/highlights/:highlightId', {
    schema: {
      summary: 'Remove a highlight from a journal',
      tags: ['journals'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          highlightId: { type: 'string' },
        },
        required: ['id', 'highlightId'],
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
  }, async (request: FastifyRequest<{ Params: { id: string; highlightId: string } }>, reply: FastifyReply) => {
    const { userId } = request.user;
    const { id, highlightId } = request.params;

    await removeHighlightFromJournal(userId, id, highlightId);

    reply.send({
      data: null,
      error: null,
      message: 'Highlight removed from journal',
    });
  });

  app.patch('/:id/highlights/reorder', {
    schema: {
      summary: 'Reorder highlights in a journal',
      tags: ['journals'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: toJsonSchema(ReorderHighlightsSchema),
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
    const parsed = ReorderHighlightsSchema.parse(request.body);
    await reorderHighlights(userId, id, parsed);

    reply.send({
      data: null,
      error: null,
      message: 'Highlights reordered',
    });
  });
}
