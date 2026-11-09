import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { updateColorLabelsSchema } from './workspace.zod';
import { getMyWorkspace, updateColorLabels } from './workspace.service';
import { resolveProfileIdFromUserId } from '../../utils/profile';

const WORKSPACE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    ownerId: { type: 'string' },
    type: { type: 'string' },
    name: { type: 'string' },
    isPersonal: { type: 'boolean' },
    colorLabels: { type: ['object', 'null'], additionalProperties: { type: 'string' } },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
};

export default async function workspaceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
  });

  app.get('/workspace/me', {
    schema: {
      summary: 'Get my workspace',
      tags: ['workspace'],
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                workspace: WORKSPACE_SCHEMA,
                counts: {
                  type: 'object',
                  properties: {
                    notes: { type: 'number' },
                    highlights: { type: 'number' },
                    journals: { type: 'number' },
                  },
                },
              },
            },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.user;
    const profileId = await resolveProfileIdFromUserId(userId);
    const workspace = await getMyWorkspace(profileId);

    reply.send({
      data: workspace,
      error: null,
      message: 'Workspace retrieved',
    });
  });

  app.patch('/workspace/me/color-labels', {
    schema: {
      summary: 'Update color labels on my workspace',
      tags: ['workspace'],
      body: {
        type: 'object',
        required: ['colorLabels'],
        properties: {
          colorLabels: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: { type: 'string', minLength: 1, maxLength: 50 },
                maxProperties: 20,
              },
            ],
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
    const parsed = updateColorLabelsSchema.parse(request.body);
    await updateColorLabels(userId, parsed.colorLabels);

    reply.send({
      data: null,
      error: null,
      message: 'Color labels updated',
    });
  });
}
