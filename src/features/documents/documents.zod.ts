import { z } from 'zod';
import { httpUrlSchema } from '../../utils/url';

export const createDocumentSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  abstract: z.string().max(500).nullable().optional(),
  content: z.record(z.string(), z.unknown()).nullable().optional(),
  coverImageUrl: httpUrlSchema().nullable().optional(),
  type: z.string().min(1, 'Document type is required'),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens').max(100).optional(),
  categoryId: z.string().cuid2().nullable().optional(),
  tags: z.array(z.string().max(30)).max(5).optional(),
  organizationId: z.string().min(1).max(64).nullable().optional(),
});
export const updateDocumentSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  abstract: z.string().max(500).nullable().optional(),
  content: z.record(z.string(), z.unknown()).nullable().optional(),
  coverImageUrl: httpUrlSchema().nullable().optional(),
  type: z.string().min(1).optional(),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens').max(100).optional(),
  typography: z.enum(['sans', 'serif', 'mono']).optional(),
  paperStyle: z.record(z.string(), z.unknown()).nullable().optional(),
  paperTexture: z.record(z.string(), z.unknown()).nullable().optional(),
  coverSettings: z.record(z.string(), z.unknown()).nullable().optional(),
  documentHeader: z.record(z.string(), z.unknown()).nullable().optional(),
  documentFooter: z.record(z.string(), z.unknown()).nullable().optional(),
  documentSignature: z.record(z.string(), z.unknown()).nullable().optional(),
  categoryId: z.string().cuid2().nullable().optional(),
  tags: z.array(z.string().max(30)).max(5).optional(),
  organizationId: z.string().min(1).max(64).nullable().optional(),
});

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;

export const feedQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20).optional(),
  type: z.string().optional(),
  author: z.string().optional(),
  q: z.string().min(1).max(100).optional(),
  sort: z.enum(['recent', 'popular']).default('recent').optional(),
  category: z.string().optional(),
  tag: z.string().optional(),
  organization: z.string().min(1).max(64).optional(),
});

export const authorFeedQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20).optional(),
  type: z.string().optional(),
});

export const organizationFeedQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20).optional(),
  type: z.string().optional(),
  sort: z.enum(['recent', 'popular']).default('recent').optional(),
});

export type FeedQueryInput = z.infer<typeof feedQuerySchema>;
export type AuthorFeedQueryInput = z.infer<typeof authorFeedQuerySchema>;
