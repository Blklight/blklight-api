import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { perUserRateLimit } from '../../utils/rate-limit';
import { createExerciseSchema, updateExerciseSchema, submitAnswerSchema } from './tutorial-exercises.zod';
import {
  createExercise,
  updateExercise,
  deleteExercise,
  getExercises,
  submitAnswer,
} from './tutorial-exercises.service';
import { resolveProfileIdFromUserId } from '../../utils/profile';
import { requireFeature } from '../../config/features';

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

export default async function tutorialExerciseRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (request, reply) => {
    await app.authenticate(request, reply);
  });

  app.get('/documents/:id/exercises', {
    schema: {
      summary: 'Get exercises for a document',
      tags: ['tutorial-exercises'],
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
            data: { type: 'array' },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;

    const profileId = await resolveProfileIdFromUserId(request.user.userId);
    const exercises = await getExercises(id, profileId);

    reply.send({
      data: exercises,
      error: null,
      message: 'Exercises retrieved',
    });
  });

  app.post('/documents/:id/exercises', {
    schema: {
      summary: 'Create an exercise for a document',
      tags: ['tutorial-exercises'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: {
        oneOf: [
          {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'code' },
              data: {
                type: 'object',
                properties: {
                  prompt: { type: 'string', minLength: 1 },
                  language: { type: 'string', minLength: 1 },
                  initialCode: { type: 'string' },
                  expectedOutput: { type: 'string', minLength: 1 },
                },
                required: ['prompt', 'language', 'initialCode', 'expectedOutput'],
              },
            },
            required: ['type', 'data'],
          },
          {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'quiz' },
              data: {
                type: 'object',
                properties: {
                  question: { type: 'string', minLength: 1 },
                  options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6 },
                  correctIndex: { type: 'number', minimum: 0 },
                },
                required: ['question', 'options', 'correctIndex'],
              },
            },
            required: ['type', 'data'],
          },
        ],
      },
      response: {
        201: {
          type: 'object',
          properties: {
            data: { type: 'object' },
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

    const parsed = createExerciseSchema.safeParse(request.body);
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

    const exercise = await createExercise(profileId, id, parsed.data);

    reply.code(201).send({
      data: exercise,
      error: null,
      message: 'Exercise created',
    });
  });

  app.patch('/exercises/:id', {
    schema: {
      summary: 'Update an exercise',
      tags: ['tutorial-exercises'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: {
        oneOf: [
          {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'code' },
              data: {
                type: 'object',
                properties: {
                  prompt: { type: 'string', minLength: 1 },
                  language: { type: 'string', minLength: 1 },
                  initialCode: { type: 'string' },
                  expectedOutput: { type: 'string', minLength: 1 },
                },
              },
            },
            required: ['type', 'data'],
          },
          {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'quiz' },
              data: {
                type: 'object',
                properties: {
                  question: { type: 'string', minLength: 1 },
                  options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6 },
                  correctIndex: { type: 'number', minimum: 0 },
                },
              },
            },
            required: ['type', 'data'],
          },
        ],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'object' },
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

    const parsed = updateExerciseSchema.safeParse(request.body);
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

    const exercise = await updateExercise(profileId, id, parsed.data);

    reply.send({
      data: exercise,
      error: null,
      message: 'Exercise updated',
    });
  });

  app.delete('/exercises/:id', {
    schema: {
      summary: 'Delete an exercise',
      tags: ['tutorial-exercises'],
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

    await deleteExercise(profileId, id);

    reply.send({
      data: null,
      error: null,
      message: 'Exercise deleted',
    });
  });

  app.post('/exercises/:id/submit', {
    config: { rateLimit: perUserRateLimit(20) },
    schema: {
      summary: 'Submit an answer to an exercise',
      tags: ['tutorial-exercises'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: {
        oneOf: [
          {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'code' },
              code: { type: 'string', minLength: 1 },
            },
            required: ['type', 'code'],
          },
          {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'quiz' },
              answerIndex: { type: 'number', minimum: 0 },
            },
            required: ['type', 'answerIndex'],
          },
        ],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                isCorrect: { type: 'boolean' },
                attemptsCount: { type: 'number' },
              },
            },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    requireFeature('codeSandbox');

    const { userId } = request.user;
    const { id } = request.params;

    const profileId = await resolveProfileIdFromUserId(userId);

    const parsed = submitAnswerSchema.safeParse(request.body);
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

    const result = await submitAnswer(profileId, id, parsed.data);

    reply.send({
      data: result,
      error: null,
      message: 'Answer submitted',
    });
  });
}
