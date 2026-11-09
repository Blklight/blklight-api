import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  createCategory,
  updateCategory,
  deleteCategory,
  getAllCategories,
  getCategoryBySlug,
} from './categories.service';
import { requireAdmin } from '../../hooks/admin-guard';

const CATEGORY_BASE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
    description: { type: ['string', 'null'] },
    parentId: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
  },
};

const CATEGORY_SCHEMA = {
  type: 'object',
  properties: {
    ...CATEGORY_BASE_SCHEMA.properties,
  },
};

const CATEGORY_WITH_CHILDREN_DEF = {
  $id: 'CategoryWithChildren',
  type: 'object',
  properties: {
    ...CATEGORY_BASE_SCHEMA.properties,
    documentCount: { type: 'number' },
    children: {
      type: 'array',
      items: { $ref: 'CategoryWithChildren#' },
    },
  },
};

const CATEGORY_WITH_CHILDREN_ROW = {
  type: 'object',
  properties: {
    ...CATEGORY_BASE_SCHEMA.properties,
    documentCount: { type: 'number' },
    children: {
      type: 'array',
      items: { $ref: 'CategoryWithChildren#' },
    },
  },
};

const createCategorySchema = z.object({
  name: z.string().min(1).max(50),
  description: z.string().max(200).nullable().optional(),
  parentId: z.string().cuid2().nullable().optional(),
});

const updateCategorySchema = z.object({
  name: z.string().min(1).max(50).optional(),
  description: z.string().max(200).nullable().optional(),
  parentId: z.string().cuid2().nullable().optional(),
});

export default async function categoryRoutes(app: FastifyInstance) {
  app.get('/', {
    schema: {
      summary: 'Get all categories',
      tags: ['categories'],
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: CATEGORY_WITH_CHILDREN_ROW,
            },
            error: { type: 'null' },
            message: { type: 'string' },
          },
          definitions: {
            CategoryWithChildren: CATEGORY_WITH_CHILDREN_DEF,
          },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const categories = await getAllCategories();

    reply.send({
      data: categories,
      error: null,
      message: 'Categories retrieved',
    });
  });

  app.get('/:slug', {
    schema: {
      summary: 'Get a category by slug',
      tags: ['categories'],
      params: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
        },
        required: ['slug'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: CATEGORY_WITH_CHILDREN_ROW,
            error: { type: 'null' },
            message: { type: 'string' },
          },
          definitions: {
            CategoryWithChildren: CATEGORY_WITH_CHILDREN_DEF,
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
  }, async (request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
    const { slug } = request.params;
    const category = await getCategoryBySlug(slug);

    if (!category) {
      return reply.code(404).send({
        data: null,
        error: { code: 'NOT_FOUND', message: 'Category not found' },
        message: 'Category not found',
      });
    }

    reply.send({
      data: category,
      error: null,
      message: 'Category retrieved',
    });
  });

  app.post('/', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply), requireAdmin],
    schema: {
      summary: 'Create a category (admin only)',
      tags: ['categories'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 50 },
          description: { type: 'string', maxLength: 200 },
          parentId: { type: 'string' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            data: CATEGORY_SCHEMA,
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
    const parsed = createCategorySchema.parse(request.body);
    const category = await createCategory(
      parsed.name,
      parsed.description,
      parsed.parentId
    );

    reply.code(201).send({
      data: category,
      error: null,
      message: 'Category created',
    });
  });

  app.patch('/:id', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply), requireAdmin],
    schema: {
      summary: 'Update a category (admin only)',
      tags: ['categories'],
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
          name: { type: 'string', minLength: 1, maxLength: 50 },
          description: { type: 'string', maxLength: 200 },
          parentId: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: CATEGORY_SCHEMA,
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
  }, async (request, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const parsed = updateCategorySchema.parse(request.body);
    const category = await updateCategory(id, parsed);

    reply.send({
      data: category,
      error: null,
      message: 'Category updated',
    });
  });

  app.delete('/:id', {
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply), requireAdmin],
    schema: {
      summary: 'Delete a category (admin only)',
      tags: ['categories'],
      security: [{ bearerAuth: [] }],
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
  }, async (request, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    await deleteCategory(id);

    reply.send({
      data: null,
      error: null,
      message: 'Category deleted',
    });
  });
}
