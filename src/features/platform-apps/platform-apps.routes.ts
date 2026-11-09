import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { toJsonSchema } from '../../utils/json-schema';
import { listApps, getUserApps, activateApps, deactivateApp, createApp, updateApp, createInvite, listInvites } from './platform-apps.service';
import { activateAppsSchema, createAppSchema, updateAppSchema, createInviteSchema } from './platform-apps.zod';
import { resolveProfileIdFromUserId } from '../../utils/profile';
import { requireAdmin } from '../../hooks/admin-guard';

export default async function platformAppsRoutes(app: FastifyInstance) {
  app.get('/platform-apps', {
    schema: {
      summary: 'List all available platform apps',
      tags: ['platform-apps'],
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
                  slug: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: ['string', 'null'] },
                  accessMode: { type: 'string' },
                  iconUrl: { type: ['string', 'null'] },
                  tagline: { type: ['string', 'null'] },
                  category: { type: ['string', 'null'] },
                  isActive: { type: 'boolean' },
                  createdAt: { type: 'string' },
                },
              },
            },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const apps = await listApps();

    reply.send({
      data: apps,
      error: null,
      message: 'Apps retrieved successfully',
    });
  });

  app.get('/platform-apps/me', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'List apps activated by current user',
      tags: ['platform-apps'],
      security: [{ bearerAuth: [] }],
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
                  appId: { type: 'string' },
                  activatedAt: { type: 'string' },
                  slug: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: ['string', 'null'] },
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
    const profileId = await resolveProfileIdFromUserId(request.user.userId);
    const userAppsList = await getUserApps(profileId);

    reply.send({
      data: userAppsList,
      error: null,
      message: 'User apps retrieved successfully',
    });
  });

  app.post('/platform-apps/me', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Activate apps for current user',
      tags: ['platform-apps'],
      security: [{ bearerAuth: [] }],
      body: toJsonSchema(activateAppsSchema),
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
    const profileId = await resolveProfileIdFromUserId(request.user.userId);
    const parsed = activateAppsSchema.parse(request.body);
    await activateApps(profileId, parsed.apps);

    reply.send({
      data: null,
      error: null,
      message: 'Apps activated successfully',
    });
  });

  app.delete('/platform-apps/me/:appId', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Deactivate an app',
      tags: ['platform-apps'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          appId: { type: 'string' },
        },
        required: ['appId'],
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
    const profileId = await resolveProfileIdFromUserId(request.user.userId);
    const { appId } = request.params as { appId: string };

    try {
      await deactivateApp(profileId, appId);
    } catch (err) {
      return reply.code(404).send({
        data: null,
        error: { code: 'NOT_FOUND', message: (err as Error).message },
        message: 'App not found',
      });
    }

    reply.send({
      data: null,
      error: null,
      message: 'App deactivated successfully',
    });
  });

  app.post('/platform-apps', {
    preHandler: [
      (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
      requireAdmin,
    ],
    schema: {
      summary: 'Create a new platform app (admin only)',
      tags: ['platform-apps'],
      security: [{ bearerAuth: [] }],
      body: toJsonSchema(createAppSchema),
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createAppSchema.parse(request.body);
    const appCreated = await createApp(parsed);

    reply.code(201).send({
      data: appCreated,
      error: null,
      message: 'App created successfully',
    });
  });

  app.patch('/platform-apps/:id', {
    preHandler: [
      (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
      requireAdmin,
    ],
    schema: {
      summary: 'Update a platform app (admin only)',
      tags: ['platform-apps'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: toJsonSchema(updateAppSchema),
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const parsed = updateAppSchema.parse(request.body);
    const appUpdated = await updateApp(id, parsed);

    reply.send({
      data: appUpdated,
      error: null,
      message: 'App updated successfully',
    });
  });

  app.post('/platform-apps/:appId/invites', {
    preHandler: [
      (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
      requireAdmin,
    ],
    schema: {
      summary: 'Authorize a profile for a beta app (admin only)',
      tags: ['platform-apps'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          appId: { type: 'string' },
        },
        required: ['appId'],
      },
      body: toJsonSchema(createInviteSchema),
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { appId } = request.params as { appId: string };
    const parsed = createInviteSchema.parse(request.body);
    const callerProfileId = await resolveProfileIdFromUserId(request.user.userId);
    const invite = await createInvite(appId, parsed.profileId, callerProfileId);

    reply.code(201).send({
      data: invite,
      error: null,
      message: 'Invite created successfully',
    });
  });

  app.get('/platform-apps/:appId/invites', {
    preHandler: [
      (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
      requireAdmin,
    ],
    schema: {
      summary: 'List invites for a beta app (admin only)',
      tags: ['platform-apps'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          appId: { type: 'string' },
        },
        required: ['appId'],
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { appId } = request.params as { appId: string };
    const invites = await listInvites(appId);

    reply.send({
      data: invites,
      error: null,
      message: 'Invites retrieved successfully',
    });
  });
}
