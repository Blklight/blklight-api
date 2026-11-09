import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { toJsonSchema } from '../../utils/json-schema';
import { createStyleTemplateSchema } from './document-style-templates.zod';
import { profiles } from '../profiles/profiles.schema';
import { db } from '../../db/index';
import { eq } from 'drizzle-orm';
import {
  createStyleTemplate,
  getMyStyleTemplates,
  deleteStyleTemplate,
} from './document-style-templates.service';

const STYLE_TEMPLATE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    authorId: { type: 'string' },
    name: { type: 'string' },
    documentType: { type: ['string', 'null'] },
    typography: { type: 'string' },
    paperStyle: { type: ['object', 'null'], additionalProperties: true },
    paperTexture: { type: ['object', 'null'], additionalProperties: true },
    documentHeader: { type: ['object', 'null'], additionalProperties: true },
    documentFooter: { type: ['object', 'null'], additionalProperties: true },
    createdAt: { type: 'string' },
  },
};

interface JwtPayload {
  userId: string;
  email: string;
  role: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

export default async function styleTemplateRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (request, reply) => {
    await app.authenticate(request, reply);
  });

  app.get('/', {
    schema: {
      summary: 'Get my style templates',
      tags: ['document-style-templates'],
      querystring: {
        type: 'object',
        properties: {
          type: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: STYLE_TEMPLATE_SCHEMA,
            },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: { type?: string } }>, reply: FastifyReply) => {
    const { userId } = request.user;
    const { type } = request.query;

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
    const templates = await getMyStyleTemplates(authorId, type);

    reply.send({
      data: templates,
      error: null,
      message: 'Templates retrieved',
    });
  });

  app.post('/', {
    schema: {
      summary: 'Create a style template',
      tags: ['document-style-templates'],
      body: toJsonSchema(createStyleTemplateSchema),
      response: {
        201: {
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
    const parsed = createStyleTemplateSchema.parse(request.body);
    const template = await createStyleTemplate(authorId, parsed);

    reply.code(201).send({
      data: template,
      error: null,
      message: 'Template created',
    });
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete a style template',
      tags: ['document-style-templates'],
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
    await deleteStyleTemplate(authorId, id);

    reply.send({
      data: null,
      error: null,
      message: 'Template deleted',
    });
  });
}
