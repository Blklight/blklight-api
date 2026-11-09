import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { perUserRateLimit } from '../../utils/rate-limit';
import {
  followProfile,
  unfollowProfile,
  getFollowers,
  getFollowing,
  getFollowingFeed,
  getPendingRequests,
  acceptFollowRequest,
  rejectFollowRequest,
  resolveProfileIdFromUserId,
} from './follows.service';

export default async function followRoutes(app: FastifyInstance) {
  app.get('/profiles/:username/followers', {
    schema: {
      summary: 'Get followers of a profile',
      tags: ['follows'],
      params: {
        type: 'object',
        properties: {
          username: { type: 'string' },
        },
        required: ['username'],
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
  }, async (request: FastifyRequest<{ Params: { username: string } }>, reply: FastifyReply) => {
    const { username } = request.params;
    let viewerProfileId: string | undefined;

    try {
      await request.jwtVerify();
      const viewerUserId = request.user.userId;
      viewerProfileId = await resolveProfileIdFromUserId(viewerUserId);
    } catch {
      viewerProfileId = undefined;
    }

    const result = await getFollowers(username, viewerProfileId);

    reply.send({
      data: result,
      error: null,
      message: 'Followers retrieved',
    });
  });

  app.get('/profiles/:username/following', {
    schema: {
      summary: 'Get following list of a profile',
      tags: ['follows'],
      params: {
        type: 'object',
        properties: {
          username: { type: 'string' },
        },
        required: ['username'],
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
  }, async (request: FastifyRequest<{ Params: { username: string } }>, reply: FastifyReply) => {
    const { username } = request.params;
    let viewerProfileId: string | undefined;

    try {
      await request.jwtVerify();
      const viewerUserId = request.user.userId;
      viewerProfileId = await resolveProfileIdFromUserId(viewerUserId);
    } catch {
      viewerProfileId = undefined;
    }

    const result = await getFollowing(username, viewerProfileId);

    reply.send({
      data: result,
      error: null,
      message: 'Following retrieved',
    });
  });

  app.post('/profiles/:username/follow', {
    config: { rateLimit: perUserRateLimit(10) },
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Follow a profile',
      tags: ['follows'],
      params: {
        type: 'object',
        properties: {
          username: { type: 'string' },
        },
        required: ['username'],
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
    const { username } = request.params as { username: string };

    const result = await followProfile(userId, username);

    reply.code(201).send({
      data: result,
      error: null,
      message: result.status === 'accepted' ? 'Following' : 'Follow request sent',
    });
  });

  app.delete('/profiles/:username/follow', {
    config: { rateLimit: perUserRateLimit(10) },
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Unfollow a profile',
      tags: ['follows'],
      params: {
        type: 'object',
        properties: {
          username: { type: 'string' },
        },
        required: ['username'],
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
    const { userId } = request.user;
    const { username } = request.params as { username: string };

    await unfollowProfile(userId, username);

    reply.send({
      data: null,
      error: null,
      message: 'Unfollowed',
    });
  });

  app.get('/feed/following', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Get following feed',
      tags: ['follows'],
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
            data: { type: 'object', additionalProperties: true },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.user;
    const query = request.query as { cursor?: string; limit?: number };
    const { cursor, limit } = query;

    const result = await getFollowingFeed(userId, { cursor, limit });

    reply.send({
      data: result,
      error: null,
      message: 'Following feed retrieved',
    });
  });

  app.get('/follows/requests', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Get pending follow requests',
      tags: ['follows'],
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
    const profileId = await resolveProfileIdFromUserId(userId);

    const requests = await getPendingRequests(profileId);

    reply.send({
      data: requests,
      error: null,
      message: 'Pending requests retrieved',
    });
  });

  app.post('/follows/requests/:id/accept', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Accept a follow request',
      tags: ['follows'],
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
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.user;
    const params = request.params as { id: string };
    const { id } = params;
    const profileId = await resolveProfileIdFromUserId(userId);

    await acceptFollowRequest(profileId, id);

    reply.send({
      data: null,
      error: null,
      message: 'Follow request accepted',
    });
  });

  app.delete('/follows/requests/:id/reject', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Reject a follow request',
      tags: ['follows'],
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
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.user;
    const params = request.params as { id: string };
    const { id } = params;
    const profileId = await resolveProfileIdFromUserId(userId);

    await rejectFollowRequest(profileId, id);

    reply.send({
      data: null,
      error: null,
      message: 'Follow request rejected',
    });
  });
}
