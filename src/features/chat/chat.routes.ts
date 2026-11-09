import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createServerSchema,
  createChannelSchema,
  addMemberSchema,
  decideMemberSchema,
  createMessageSchema,
  updateMessageSchema,
  messageQuerySchema,
} from './chat.zod';
import {
  createServer,
  listMyServers,
  listAllServers,
  getServerDetail,
  addMember,
  listMembers,
  listMembersAdminBypass,
  decideMember,
  removeMember,
  createChannel,
  listChannels,
  sendMessage,
  listMessages,
  editMessage,
  deleteMessage,
  assertCanAccessChannel,
  resolveProfileIdFromUserId,
} from './chat.service';
import { requireAdmin } from '../../hooks/admin-guard';
import { createWsTicket, consumeWsTicket } from './ws-tickets';
import { subscribeChannel, unsubscribeChannel, removeConnection } from './ws-registry';
import type { WebSocket } from 'ws';

interface JwtPayload {
  userId: string;
  email: string;
  role: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

interface ServerParams {
  serverId: string;
}

interface ServerMemberParams {
  serverId: string;
  memberId: string;
}

interface ChannelParams {
  channelId: string;
}

interface MessageParams {
  messageId: string;
}

interface MessageQuery {
  cursor?: string;
  limit?: number;
}

function sendValidationError(
  reply: FastifyReply,
  parsed: { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } }
) {
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

export default async function chatRoutes(app: FastifyInstance) {
  app.post('/chat/servers', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply), requireAdmin],
    schema: {
      summary: 'Create a chat server (admin only)',
      tags: ['chat'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          iconUrl: { type: 'string', format: 'uri' },
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
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createServerSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed);
    }

    const server = await createServer(request.user.userId, parsed.data);

    reply.code(201).send({
      data: server,
      error: null,
      message: 'Chat server created',
    });
  });

  app.get('/chat/servers', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'List my chat servers',
      tags: ['chat'],
      security: [{ bearerAuth: [] }],
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
    const servers = await listMyServers(request.user.userId);

    reply.send({
      data: servers,
      error: null,
      message: 'Chat servers retrieved',
    });
  });

  app.get('/chat/servers/all', {
    preHandler: [
      (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
      requireAdmin,
    ],
    schema: {
      summary: 'List all chat servers with member counts (admin only)',
      tags: ['chat', 'admin'],
      security: [{ bearerAuth: [] }],
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const servers = await listAllServers();

    reply.send({
      data: servers,
      error: null,
      message: 'All chat servers retrieved',
    });
  });

  app.get('/chat/servers/:serverId', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Get a chat server with its channels',
      tags: ['chat'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          serverId: { type: 'string' },
        },
        required: ['serverId'],
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
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { serverId } = request.params as ServerParams;
    const result = await getServerDetail(request.user.userId, serverId);

    reply.send({
      data: result,
      error: null,
      message: 'Chat server retrieved',
    });
  });

  app.post('/chat/servers/:serverId/members', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Add a member to a chat server',
      tags: ['chat'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          serverId: { type: 'string' },
        },
        required: ['serverId'],
      },
      body: {
        type: 'object',
        required: ['profileId'],
        properties: {
          profileId: { type: 'string' },
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
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { serverId } = request.params as ServerParams;
    const parsed = addMemberSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed);
    }

    const member = await addMember(request.user.userId, serverId, parsed.data.profileId);

    reply.code(201).send({
      data: member,
      error: null,
      message: 'Member added',
    });
  });

  app.get('/chat/servers/:serverId/members', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'List members of a chat server',
      tags: ['chat'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          serverId: { type: 'string' },
        },
        required: ['serverId'],
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
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { serverId } = request.params as ServerParams;
    const isAdmin = request.user.role === 'admin';
    const members = isAdmin
      ? await listMembersAdminBypass(serverId)
      : await listMembers(request.user.userId, serverId);

    reply.send({
      data: members,
      error: null,
      message: 'Members retrieved',
    });
  });

  app.patch('/chat/servers/:serverId/members/:memberId', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Approve or reject a pending chat server member',
      tags: ['chat'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          serverId: { type: 'string' },
          memberId: { type: 'string' },
        },
        required: ['serverId', 'memberId'],
      },
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['accepted', 'rejected'] },
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
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { serverId, memberId } = request.params as ServerMemberParams;
    const parsed = decideMemberSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed);
    }

    const member = await decideMember(request.user.userId, serverId, memberId, parsed.data.status);

    reply.send({
      data: member,
      error: null,
      message: `Member ${parsed.data.status}`,
    });
  });

  app.delete('/chat/servers/:serverId/members/:memberId', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Remove a member from a chat server',
      tags: ['chat'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          serverId: { type: 'string' },
          memberId: { type: 'string' },
        },
        required: ['serverId', 'memberId'],
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
    const { serverId, memberId } = request.params as ServerMemberParams;
    await removeMember(request.user.userId, serverId, memberId);

    reply.send({
      data: null,
      error: null,
      message: 'Member removed',
    });
  });

  app.post('/chat/servers/:serverId/channels', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Create a channel in a chat server',
      tags: ['chat'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          serverId: { type: 'string' },
        },
        required: ['serverId'],
      },
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          type: { type: 'string', enum: ['text'] },
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
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { serverId } = request.params as ServerParams;
    const parsed = createChannelSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed);
    }

    const channel = await createChannel(request.user.userId, serverId, parsed.data);

    reply.code(201).send({
      data: channel,
      error: null,
      message: 'Channel created',
    });
  });

  app.get('/chat/servers/:serverId/channels', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'List channels of a chat server',
      tags: ['chat'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          serverId: { type: 'string' },
        },
        required: ['serverId'],
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
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { serverId } = request.params as ServerParams;
    const channels = await listChannels(request.user.userId, serverId);

    reply.send({
      data: channels,
      error: null,
      message: 'Channels retrieved',
    });
  });

  app.post('/chat/channels/:channelId/messages', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
      },
    },
    schema: {
      summary: 'Send a message to a channel',
      tags: ['chat'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          channelId: { type: 'string' },
        },
        required: ['channelId'],
      },
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 4000 },
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
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { channelId } = request.params as ChannelParams;
    const parsed = createMessageSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed);
    }

    const message = await sendMessage(request.user.userId, channelId, parsed.data.content);

    reply.code(201).send({
      data: message,
      error: null,
      message: 'Message sent',
    });
  });

  app.get('/chat/channels/:channelId/messages', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'List messages in a channel',
      tags: ['chat'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          channelId: { type: 'string' },
        },
        required: ['channelId'],
      },
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
                items: { type: 'array' },
                nextCursor: { type: ['string', 'null'] },
                total: { type: 'number' },
              },
            },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { channelId } = request.params as ChannelParams;
    const parsed = messageQuerySchema.safeParse(request.query as MessageQuery);

    if (!parsed.success) {
      return sendValidationError(reply, parsed);
    }

    const result = await listMessages(request.user.userId, channelId, parsed.data);

    reply.send({
      data: result,
      error: null,
      message: 'Messages retrieved',
    });
  });

  app.patch('/chat/messages/:messageId', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Edit a message',
      tags: ['chat'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          messageId: { type: 'string' },
        },
        required: ['messageId'],
      },
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 4000 },
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
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { messageId } = request.params as MessageParams;
    const parsed = updateMessageSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed);
    }

    const message = await editMessage(request.user.userId, messageId, parsed.data.content);

    reply.send({
      data: message,
      error: null,
      message: 'Message updated',
    });
  });

  app.delete('/chat/messages/:messageId', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Soft delete a message',
      tags: ['chat'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          messageId: { type: 'string' },
        },
        required: ['messageId'],
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
    const { messageId } = request.params as MessageParams;
    await deleteMessage(request.user.userId, messageId);

    reply.send({
      data: null,
      error: null,
      message: 'Message deleted',
    });
  });

  app.post('/chat/ws-ticket', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
      },
    },
    schema: {
      summary: 'Create a WebSocket connection ticket',
      tags: ['chat'],
      security: [{ bearerAuth: [] }],
      response: {
        201: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                ticket: { type: 'string' },
                expiresIn: { type: 'number' },
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
    const result = createWsTicket(profileId);

    reply.code(201).send({
      data: result,
      error: null,
      message: 'WebSocket ticket created',
    });
  });

  app.get('/chat/ws', {
    websocket: true,
  }, (socket: WebSocket, request: FastifyRequest) => {
    const { ticket, channelId } = request.query as { ticket?: string; channelId?: string };

    if (!ticket || !channelId) {
      socket.close(4400, 'Missing ticket or channelId');
      return;
    }

    const profileId = consumeWsTicket(ticket);
    if (!profileId) {
      socket.close(4401, 'Invalid or expired ticket');
      return;
    }

    void assertCanAccessChannel(profileId, channelId)
      .then(() => {
        subscribeChannel(channelId, { connection: socket, profileId });

        socket.send(JSON.stringify({ type: 'subscribed', channelId }));

        socket.on('message', () => {
          // read-only transport — writes go through the REST API
        });

        socket.on('close', () => {
          removeConnection(socket);
        });
      })
      .catch(() => {
        socket.close(4403, 'Access denied to channel');
      });
  });
}
