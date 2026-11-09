import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createHighlightSchema,
  updateHighlightSchema,
  updatePaletteSchema,
  highlightQuerySchema,
} from './highlights.zod';
import {
  createHighlight,
  updateHighlight,
  deleteHighlight,
  getMyHighlights,
  getDocumentHighlights,
  getPalette,
  updatePalette,
} from './highlights.service';
import { resolveProfileIdFromUserId } from '../../utils/profile';

const SELECTION_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    color: { type: 'string' },
    position: {
      type: 'object',
      properties: {
        nodeIndex: { type: 'number' },
        offsetStart: { type: 'number' },
        offsetEnd: { type: 'number' },
      },
    },
  },
};

const DOCUMENT_REF_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    slug: { type: 'string' },
    authorUsername: { type: 'string' },
  },
};

const HIGHLIGHT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    profileId: { type: 'string' },
    documentId: { type: 'string' },
    selection: SELECTION_SCHEMA,
    annotation: { type: ['object', 'null'], additionalProperties: true },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
};

const HIGHLIGHT_GROUP_SCHEMA = {
  type: 'object',
  properties: {
    document: DOCUMENT_REF_SCHEMA,
    highlights: { type: 'array', items: HIGHLIGHT_SCHEMA },
  },
};

export default async function highlightRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
  });

  app.get('/highlights/palette', {
    schema: {
      summary: 'Get my highlight palette',
      tags: ['highlights'],
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
    const { userId } = request.user;
    const profileId = await resolveProfileIdFromUserId(userId);
    const palette = await getPalette(profileId);

    reply.send({
      data: palette,
      error: null,
      message: 'Palette retrieved',
    });
  });

  app.patch('/highlights/palette', {
    schema: {
      summary: 'Update my highlight palette',
      tags: ['highlights'],
      body: {
        type: 'object',
        required: ['colors'],
        properties: {
          colors: {
            type: 'array',
            items: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
            minItems: 5,
            maxItems: 5,
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
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.user;
    const parsed = updatePaletteSchema.safeParse(request.body);

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

    const profileId = await resolveProfileIdFromUserId(userId);
    await updatePalette(profileId, parsed.data.colors);

    reply.send({
      data: null,
      error: null,
      message: 'Palette updated',
    });
  });

  app.get('/highlights/me', {
    schema: {
      summary: 'Get my highlights grouped by document',
      tags: ['highlights'],
      querystring: {
        type: 'object',
        properties: {
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                items: { type: 'array', items: HIGHLIGHT_GROUP_SCHEMA },
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
    Querystring: { cursor?: string; limit?: number }
  }>, reply: FastifyReply) => {
    const { userId } = request.user;
    const parsed = highlightQuerySchema.safeParse(request.query);

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

    const profileId = await resolveProfileIdFromUserId(userId);
    const result = await getMyHighlights(profileId, parsed.data);

    reply.send({
      data: result,
      error: null,
      message: 'Highlights retrieved',
    });
  });

  app.patch('/highlights/:id', {
    schema: {
      summary: 'Update a highlight',
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
        properties: {
          selection: {
            type: 'object',
            properties: {
              text: { type: 'string', minLength: 1, maxLength: 2000 },
              color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
              position: {
                type: 'object',
                properties: {
                  nodeIndex: { type: 'number' },
                  offsetStart: { type: 'number' },
                  offsetEnd: { type: 'number' },
                },
              },
            },
          },
          annotation: { type: 'object', nullable: true },
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
    const parsed = updateHighlightSchema.safeParse(request.body);

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

    const profileId = await resolveProfileIdFromUserId(userId);
    const highlight = await updateHighlight(profileId, id, parsed.data);

    reply.send({
      data: highlight,
      error: null,
      message: 'Highlight updated',
    });
  });

  app.delete('/highlights/:id', {
    schema: {
      summary: 'Delete a highlight',
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

    const profileId = await resolveProfileIdFromUserId(userId);
    await deleteHighlight(profileId, id);

    reply.send({
      data: null,
      error: null,
      message: 'Highlight deleted',
    });
  });
}
