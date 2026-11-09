import { z } from 'zod';
import { httpUrlSchema } from '../../utils/url';

export const headingSchema = z.object({
  level: z.number().int().min(1).max(6),
  text: z.string(),
  anchor: z.string(),
});

export const tocItemSchema = z.object({
  chapterId: z.string(),
  title: z.string(),
  headings: z.array(headingSchema),
});

export const createBookSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  description: z.string().max(500).nullable().optional(),
  coverImageUrl: httpUrlSchema().nullable().optional(),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens').max(100).optional(),
  categoryId: z.string().cuid2().nullable().optional(),
  tags: z.array(z.string().max(30)).max(5).optional(),
});

export const updateBookSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(500).nullable().optional(),
  coverImageUrl: httpUrlSchema().nullable().optional(),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens').max(100).optional(),
  categoryId: z.string().cuid2().nullable().optional(),
  tags: z.array(z.string().max(30)).max(5).optional(),
});

export const addChapterSchema = z.object({
  documentId: z.string().cuid2(),
  position: z.number().int().min(1).optional(),
  introText: z.string().max(1000).nullable().optional(),
  outroText: z.string().max(1000).nullable().optional(),
});

export const updateChapterSchema = z.object({
  introText: z.string().max(1000).nullable().optional(),
  outroText: z.string().max(1000).nullable().optional(),
  position: z.number().int().min(1).optional(),
});

export const reorderChaptersSchema = z.object({
  chapters: z.array(z.object({
    id: z.string(),
    position: z.number().int().min(1),
  })),
});

export const updateTocSchema = z.object({
  toc: z.array(tocItemSchema),
});

export const bookFeedQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20).optional(),
  category: z.string().optional(),
  tag: z.string().optional(),
  q: z.string().min(1).max(100).optional(),
  sort: z.enum(['recent', 'popular']).default('recent').optional(),
});

export type CreateBookInput = z.infer<typeof createBookSchema>;
export type UpdateBookInput = z.infer<typeof updateBookSchema>;
export type AddChapterInput = z.infer<typeof addChapterSchema>;
export type UpdateChapterInput = z.infer<typeof updateChapterSchema>;
export type ReorderChaptersInput = z.infer<typeof reorderChaptersSchema>;
export type UpdateTocInput = z.infer<typeof updateTocSchema>;
export type BookFeedQueryInput = z.infer<typeof bookFeedQuerySchema>;
