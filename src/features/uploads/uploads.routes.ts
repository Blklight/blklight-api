import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { toJsonSchema } from '../../utils/json-schema';
import { perUserRateLimit } from '../../utils/rate-limit';
import { requireFeature } from '../../config/features';
import { AppError, ValidationError } from '../../utils/errors';
import { uploadQuerySchema } from './uploads.zod';
import { storeImage } from './uploads.service';

export default async function uploadsRoutes(app: FastifyInstance) {
  app.post('/', {
    config: { rateLimit: perUserRateLimit(30) },
    preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
    schema: {
      summary: 'Upload an image (multipart field "file"); stored as optimized WebP',
      tags: ['uploads'],
      querystring: toJsonSchema(uploadQuerySchema),
      response: {
        201: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                bytes: { type: 'integer' },
              },
            },
            error: { type: 'null' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    requireFeature('uploads');
    const { purpose } = uploadQuerySchema.parse(request.query);

    if (!request.isMultipart()) throw new ValidationError('Expected multipart/form-data with a "file" field');
    const file = await request.file();
    if (!file) throw new ValidationError('Missing "file" field');

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new AppError('FILE_TOO_LARGE', 'Image must be at most 10 MB', 413);
      }
      throw err;
    }

    const result = await storeImage(request.user.userId, purpose, buffer);
    reply.code(201).send({ data: result, error: null, message: 'Image uploaded' });
  });
}
