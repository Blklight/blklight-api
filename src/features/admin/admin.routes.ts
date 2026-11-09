import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getAdminOverview, listUsers, getUserDetail, updateUserRole } from './admin.service';
import { listAllApps } from '../platform-apps/platform-apps.service';
import { listUsersQuerySchema, updateRoleSchema } from './admin.zod';
import { requireAdmin } from '../../hooks/admin-guard';

export default async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/overview', {
    preHandler: [
      (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
      requireAdmin,
    ],
    schema: {
      summary: 'Admin dashboard overview (admin only)',
      tags: ['admin'],
      security: [{ bearerAuth: [] }],
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const overview = await getAdminOverview();

    reply.send({
      data: overview,
      error: null,
      message: 'Overview retrieved successfully',
    });
  });

  app.get('/admin/users', {
    preHandler: [
      (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
      requireAdmin,
    ],
    schema: {
      summary: 'List users with filters (admin only)',
      tags: ['admin'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          role: { type: 'string', enum: ['user', 'admin'] },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          deleted: { type: 'string', enum: ['true', 'false'], default: 'false' },
        },
        additionalProperties: false,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = listUsersQuerySchema.parse(request.query);
    const result = await listUsers(parsed);

    reply.send({
      data: result,
      error: null,
      message: 'Users retrieved successfully',
    });
  });

  app.get('/admin/platform-apps', {
    preHandler: [
      (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
      requireAdmin,
    ],
    schema: {
      summary: 'List all platform apps (admin only, includes inactive)',
      tags: ['admin'],
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
    const apps = await listAllApps();

    reply.send({
      data: apps,
      error: null,
      message: 'All platform apps retrieved successfully',
    });
  });

  app.get('/admin/users/:id', {
    preHandler: [
      (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
      requireAdmin,
    ],
    schema: {
      summary: 'Get user detail (admin only)',
      tags: ['admin'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    try {
      const detail = await getUserDetail(id);

      reply.send({
        data: detail,
        error: null,
        message: 'User detail retrieved successfully',
      });
    } catch (err) {
      if ((err as Error).message === 'User not found') {
        return reply.code(404).send({
          data: null,
          error: { code: 'NOT_FOUND', message: 'User not found' },
          message: 'User not found',
        });
      }
      throw err;
    }
  });

  app.patch('/admin/users/:id/role', {
    preHandler: [
      (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
      requireAdmin,
    ],
    schema: {
      summary: 'Update user role (admin only)',
      tags: ['admin'],
      security: [{ bearerAuth: [] }],
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
          role: { type: 'string', enum: ['user', 'admin'] },
        },
        required: ['role'],
        additionalProperties: false,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const parsed = updateRoleSchema.parse(request.body);
    try {
      const result = await updateUserRole(id, parsed.role);

      reply.send({
        data: result,
        error: null,
        message: 'Role updated successfully',
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'User not found') {
        return reply.code(404).send({
          data: null,
          error: { code: 'NOT_FOUND', message: 'User not found' },
          message: 'User not found',
        });
      }
      if (msg === 'Role unchanged') {
        return reply.send({
          data: { message: 'Role unchanged' },
          error: null,
          message: 'Role unchanged',
        });
      }
      throw err;
    }
  });
}
