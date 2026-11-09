import { z } from 'zod';
import { httpUrlSchema } from '../../utils/url';

export const createServerSchema = z.object({
  name: z.string().min(1, 'Server name is required').max(100),
  iconUrl: httpUrlSchema().nullable().optional(),
});

export const createChannelSchema = z.object({
  name: z.string().min(1, 'Channel name is required').max(100),
  type: z.enum(['text']).default('text').optional(),
});

export const addMemberSchema = z.object({
  profileId: z.string().cuid2(),
});

export const decideMemberSchema = z.object({
  status: z.enum(['accepted', 'rejected']),
});

export const createMessageSchema = z.object({
  content: z.string().min(1, 'Message content is required').max(4000),
});

export const updateMessageSchema = z.object({
  content: z.string().min(1, 'Message content is required').max(4000),
});

export const messageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20).optional(),
});

export type CreateServerInput = z.infer<typeof createServerSchema>;
export type CreateChannelInput = z.infer<typeof createChannelSchema>;
export type CreateMessageInput = z.infer<typeof createMessageSchema>;
export type UpdateMessageInput = z.infer<typeof updateMessageSchema>;
export type MessageQueryInput = z.infer<typeof messageQuerySchema>;
