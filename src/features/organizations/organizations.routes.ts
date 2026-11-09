import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { toJsonSchema } from '../../utils/json-schema';
import {
  createOrganizationSchema,
  inviteMemberSchema,
  decideMembershipSchema,
} from './organizations.zod';
import {
  createOrganization,
  listMyOrganizations,
  inviteMember,
  decideMembership,
  removeMember,
  leaveOrganization,
  listMembers,
  getOrganizationByOrgname,
} from './organizations.service';
import { getOrganizationDocuments } from '../documents/documents.service';
import { organizationFeedQuerySchema } from '../documents/documents.zod';
import { DOCUMENT_CARD_SCHEMA } from '../documents/documents.routes';
import { resolveProfileIdFromUserId } from '../../utils/profile';

const ORG_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    ownerId: { type: 'string' },
    name: { type: 'string' },
    orgname: { type: 'string' },
    description: { type: ['string', 'null'] },
    isPrivate: { type: 'boolean' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
};

const ORG_LIST_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    ...ORG_SCHEMA.properties,
    myRole: { type: 'string' },
  },
};

const MEMBER_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    orgId: { type: 'string' },
    profileId: { type: 'string' },
    role: { type: 'string' },
    status: { type: 'string' },
    invitedBy: { type: ['string', 'null'] },
    requestedAt: { type: 'string' },
    decidedAt: { type: ['string', 'null'] },
    username: { type: 'string' },
    displayName: { type: ['string', 'null'] },
    avatarUrl: { type: ['string', 'null'] },
  },
};

const SUCCESS_WITH_DATA = (dataSchema: object) => ({
  type: 'object',
  properties: {
    data: dataSchema,
    error: { type: 'null' },
    message: { type: 'string' },
  },
});

const SUCCESS_WITH_ARRAY = (itemSchema: object) => ({
  type: 'object',
  properties: {
    data: { type: 'array', items: itemSchema },
    error: { type: 'null' },
    message: { type: 'string' },
  },
});

const SUCCESS_WITH_FEED = (itemSchema: object) => ({
  type: 'object',
  properties: {
    data: {
      type: 'object',
      properties: {
        items: { type: 'array', items: itemSchema },
        nextCursor: { type: ['string', 'null'] },
        total: { type: 'number' },
      },
    },
    error: { type: 'null' },
    message: { type: 'string' },
  },
});

const NEUTRAL = {
  type: 'object',
  properties: {
    data: { type: 'null' },
    error: { type: 'null' },
    message: { type: 'string' },
  },
};

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

interface OrgParams {
  id: string;
}

interface OrgMemberParams {
  id: string;
  profileId: string;
}

export default async function organizationRoutes(app: FastifyInstance) {
  app.get('/org/:orgname', {
    schema: {
      summary: 'Get a public organization by orgname',
      description:
        'Private organizations are only returned to accepted members; otherwise a 404 is returned.',
      tags: ['organizations'],
      params: {
        type: 'object',
        properties: {
          orgname: { type: 'string' },
        },
        required: ['orgname'],
      },
      response: {
        200: SUCCESS_WITH_DATA(ORG_SCHEMA),
      },
    },
  }, async (request: FastifyRequest<{ Params: { orgname: string } }>, reply: FastifyReply) => {
    const { orgname } = request.params;

    let profileId: string | null = null;
    try {
      await request.jwtVerify();
      profileId = await resolveProfileIdFromUserId(request.user.userId);
    } catch {
      profileId = null;
    }

    const org = await getOrganizationByOrgname(orgname, profileId);

    reply.send({
      data: org,
      error: null,
      message: 'Organization retrieved',
    });
  });

  app.get('/org/:orgname/documents', {
    schema: {
      summary: 'List the published documents of an organization',
      description:
        'Private organizations answer 404 for everyone but their accepted members. Documents of private authors follow the same rule as the public feed.',
      tags: ['organizations'],
      params: {
        type: 'object',
        properties: {
          orgname: { type: 'string' },
        },
        required: ['orgname'],
      },
      querystring: toJsonSchema(organizationFeedQuerySchema),
      response: {
        200: SUCCESS_WITH_FEED(DOCUMENT_CARD_SCHEMA),
      },
    },
  }, async (request: FastifyRequest<{ Params: { orgname: string } }>, reply: FastifyReply) => {
    const { orgname } = request.params;
    const parsed = organizationFeedQuerySchema.parse(request.query);
    // Auth is optional: anonymous visitors can list the documents of a public
    // organization, while an accepted member of a private one sees it too.
    let profileId: string | undefined;
    try {
      await request.jwtVerify();
      profileId = await resolveProfileIdFromUserId(request.user.userId);
    } catch {
      profileId = undefined;
    }

    const result = await getOrganizationDocuments(orgname, parsed, profileId);

    reply.send({
      data: result,
      error: null,
      message: 'Organization documents retrieved',
    });
  });

  await app.register(async function protectedOrganizations(app: FastifyInstance) {
    app.addHook('preHandler', async (request, reply) => {
      await app.authenticate(request, reply);
    });

    app.post('/organizations', {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 hour',
        },
      },
      schema: {
        summary: 'Create an organization',
        tags: ['organizations'],
        security: [{ bearerAuth: [] }],
        body: toJsonSchema(createOrganizationSchema),
        response: {
          201: SUCCESS_WITH_DATA(ORG_SCHEMA),
        },
      },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createOrganizationSchema.parse(request.body);
      const profileId = await resolveProfileIdFromUserId(request.user.userId);
      const org = await createOrganization(profileId, parsed);

      reply.code(201).send({
        data: org,
        error: null,
        message: 'Organization created',
      });
    });

    app.get('/organizations/me', {
      schema: {
        summary: 'List organizations where I am an accepted member',
        tags: ['organizations'],
        security: [{ bearerAuth: [] }],
        response: {
          200: SUCCESS_WITH_ARRAY(ORG_LIST_ITEM_SCHEMA),
        },
      },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      const profileId = await resolveProfileIdFromUserId(request.user.userId);
      const orgs = await listMyOrganizations(profileId);

      reply.send({
        data: orgs,
        error: null,
        message: 'Organizations retrieved',
      });
    });

    app.post('/organizations/:id/invite', {
      schema: {
        summary: 'Invite a profile to an organization',
        description: 'Owner/admin only. Creates a pending membership.',
        tags: ['organizations'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        body: toJsonSchema(inviteMemberSchema),
        response: {
          201: SUCCESS_WITH_DATA(MEMBER_ITEM_SCHEMA),
        },
      },
    }, async (request: FastifyRequest<{ Params: OrgParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const parsed = inviteMemberSchema.parse(request.body);
      const profileId = await resolveProfileIdFromUserId(request.user.userId);
      const member = await inviteMember(id, profileId, parsed.profileId);

      reply.code(201).send({
        data: member,
        error: null,
        message: 'Invitation sent',
      });
    });

    app.post('/organizations/:id/decide', {
      schema: {
        summary: 'Accept or reject my pending invitation',
        tags: ['organizations'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        body: toJsonSchema(decideMembershipSchema),
        response: {
          200: SUCCESS_WITH_DATA(MEMBER_ITEM_SCHEMA),
        },
      },
    }, async (request: FastifyRequest<{ Params: OrgParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const parsed = decideMembershipSchema.parse(request.body);
      const profileId = await resolveProfileIdFromUserId(request.user.userId);
      const member = await decideMembership(id, profileId, parsed.decision);

      reply.send({
        data: member,
        error: null,
        message: `Invitation ${parsed.decision}`,
      });
    });

    app.delete('/organizations/:id/members/me', {
      schema: {
        summary: 'Leave an organization',
        description: 'Any member can leave. The owner cannot.',
        tags: ['organizations'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        response: {
          200: NEUTRAL,
        },
      },
    }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const profileId = await resolveProfileIdFromUserId(request.user.userId);

      await leaveOrganization(request.params.id, profileId);

      reply.send({
        data: null,
        error: null,
        message: 'Left organization',
      });
    });

    app.delete('/organizations/:id/members/:profileId', {
      schema: {
        summary: 'Remove a member from an organization',
        description: 'Owner/admin only. The owner cannot be removed.',
        tags: ['organizations'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            profileId: { type: 'string' },
          },
          required: ['id', 'profileId'],
        },
        response: {
          200: NEUTRAL,
        },
      },
    }, async (request: FastifyRequest<{ Params: OrgMemberParams }>, reply: FastifyReply) => {
      const { id, profileId } = request.params;
      const requesterProfileId = await resolveProfileIdFromUserId(request.user.userId);

      await removeMember(id, requesterProfileId, profileId);

      reply.send({
        data: null,
        error: null,
        message: 'Member removed',
      });
    });

    app.get('/organizations/:id/members', {
      schema: {
        summary: 'List accepted members of an organization',
        description: 'Only accepted members of the organization can list.',
        tags: ['organizations'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        response: {
          200: SUCCESS_WITH_ARRAY(MEMBER_ITEM_SCHEMA),
        },
      },
    }, async (request: FastifyRequest<{ Params: OrgParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const profileId = await resolveProfileIdFromUserId(request.user.userId);
      const members = await listMembers(id, profileId);

      reply.send({
        data: members,
        error: null,
        message: 'Members retrieved',
      });
    });
  });
}