import { z } from 'zod';
import { httpUrlSchema } from '../../utils/url';

export const activateAppsSchema = z.object({
  apps: z.array(z.string()).min(1),
});

export type ActivateAppsInput = z.infer<typeof activateAppsSchema>;

export const createAppSchema = z.object({
  slug: z.string().min(1).max(50),
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  accessMode: z.enum(['open', 'beta']).default('open'),
  iconUrl: httpUrlSchema().nullable().optional(),
  tagline: z.string().max(200).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
});

export type CreateAppInput = z.infer<typeof createAppSchema>;

export const updateAppSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  accessMode: z.enum(['open', 'beta']).optional(),
  iconUrl: httpUrlSchema().nullable().optional(),
  tagline: z.string().max(200).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  isActive: z.boolean().optional(),
});

export type UpdateAppInput = z.infer<typeof updateAppSchema>;

export const createInviteSchema = z.object({
  profileId: z.string().min(1),
});

export type CreateInviteInput = z.infer<typeof createInviteSchema>;