import { z } from 'zod';

export const uploadQuerySchema = z.object({
  purpose: z.enum(['editor', 'avatar']),
});

export type UploadQuery = z.infer<typeof uploadQuerySchema>;
