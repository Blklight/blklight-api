import { eq, and, isNull, desc, count, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { db } from '../../db/index';
import {
  books,
  bookChapters,
  bookCategory,
  bookTags,
  bookProgress,
  bookChapterProgress,
  Book,
  NewBook,
  BookChapter,
  NewBookChapter,
  BookProgress,
} from './books.schema';
import { profiles } from '../profiles/profiles.schema';
import { documents } from '../documents/documents.schema';
import { categories } from '../categories/categories.schema';
import { tags as tagsTable } from '../tags/tags.schema';
import { normalizeTag, upsertTags } from '../tags/tags.service';
import { users } from '../auth/auth.schema';
import { signDocument } from '../signatures/signatures.service';
import { ValidationError, NotFoundError, ConflictError } from '../../utils/errors';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { matchUsername } from '../../utils/username';
import { generateToc, ChapterWithDocument } from '../../utils/toc';
import type {
  CreateBookInput,
  UpdateBookInput,
  AddChapterInput,
  UpdateChapterInput,
  ReorderChaptersInput,
  UpdateTocInput,
} from './books.zod';

/**
 * Books signed before userHash left Authorship still store it in jsonb; drop
 * it on read so it never reaches a reader.
 * @param authorship - Stored authorship jsonb
 * @returns Authorship without userHash
 */
function stripLegacyUserHash(authorship: unknown): Authorship {
  const { userHash: _userHash, ...rest } = authorship as Authorship & { userHash?: string };
  return rest;
}

export interface Authorship {
  authorName: string;
  username: string;
  documentHash: string;
  publicIdentifier: string;
  hmac: string;
  signedAt: string;
}

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100);
}

async function ensureUniqueBookSlug(authorId: string, slug: string, excludeId?: string): Promise<string> {
  let finalSlug = slug;
  let counter = 1;

  while (true) {
    const conditions = [
      eq(books.authorId, authorId),
      eq(books.slug, finalSlug),
    ];

    if (excludeId) {
      conditions.push(eq(books.id, excludeId));
    }

    const existing = await db
      .select({ id: books.id })
      .from(books)
      .where(and(...conditions))
      .limit(1);

    if (existing.length === 0) {
      return finalSlug;
    }

    finalSlug = `${slug}-${counter}`;
    counter++;
  }
}

async function setBookCategory(bookId: string, categoryId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(bookCategory)
      .where(eq(bookCategory.bookId, bookId));

    await tx.insert(bookCategory).values({
      bookId,
      categoryId,
    });
  });
}

async function removeBookCategory(bookId: string): Promise<void> {
  await db
    .delete(bookCategory)
    .where(eq(bookCategory.bookId, bookId));
}

async function setBookTags(bookId: string, tagNames: string[]): Promise<void> {
  const uniqueNames = [...new Set(tagNames.map((n) => normalizeTag(n)))];
  const tagRecords = await upsertTags(uniqueNames);

  await db.transaction(async (tx) => {
    await tx
      .delete(bookTags)
      .where(eq(bookTags.bookId, bookId));

    for (const tag of tagRecords) {
      await tx.insert(bookTags).values({
        bookId,
        tagId: tag.id,
      });
    }
  });
}

async function removeBookTags(bookId: string): Promise<void> {
  await db
    .delete(bookTags)
    .where(eq(bookTags.bookId, bookId));
}

async function getBookTags(bookId: string): Promise<{ id: string; name: string; slug: string }[]> {
  const results = await db
    .select({
      id: tagsTable.id,
      name: tagsTable.name,
      slug: tagsTable.slug,
    })
    .from(bookTags)
    .innerJoin(tagsTable, eq(bookTags.tagId, tagsTable.id))
    .where(eq(bookTags.bookId, bookId));

  return results;
}

async function getBookCategory(bookId: string): Promise<{ id: string; name: string; slug: string } | null> {
  const [docCat] = await db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
    })
    .from(bookCategory)
    .innerJoin(categories, eq(bookCategory.categoryId, categories.id))
    .where(eq(bookCategory.bookId, bookId))
    .limit(1);

  return docCat ?? null;
}

async function regenerateToc(bookId: string): Promise<void> {
  const chapters = await db
    .select({
      id: bookChapters.id,
      documentId: bookChapters.documentId,
      position: bookChapters.position,
      introText: bookChapters.introText,
      outroText: bookChapters.outroText,
      documentTitle: documents.title,
      documentContent: documents.content,
    })
    .from(bookChapters)
    .innerJoin(documents, eq(bookChapters.documentId, documents.id))
    .where(eq(bookChapters.bookId, bookId))
    .orderBy(bookChapters.position);

  const tocChapters: ChapterWithDocument[] = chapters.map((c) => ({
    id: c.id,
    documentId: c.documentId,
    position: c.position,
    introText: c.introText,
    outroText: c.outroText,
    document: {
      id: c.documentId,
      title: c.documentTitle,
      content: c.documentContent as ChapterWithDocument['document']['content'],
    },
  }));

  const toc = generateToc(tocChapters);

  await db
    .update(books)
    .set({ toc, updatedAt: new Date() })
    .where(eq(books.id, bookId));
}

/**
 * Create a new book.
 * @param authorId - The author's profile ID
 * @param data - Book creation data
 * @returns Created book
 */
export async function createBook(authorId: string, data: CreateBookInput): Promise<Book> {
  const baseSlug = data.slug ?? generateSlug(data.title);
  const slug = await ensureUniqueBookSlug(authorId, baseSlug);
  const now = new Date();
  const bookId = createId();

  const [book] = await db
    .insert(books)
    .values({
      id: bookId,
      authorId,
      title: data.title,
      description: data.description ?? null,
      coverImageUrl: data.coverImageUrl ?? null,
      slug,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (data.categoryId) {
    await setBookCategory(bookId, data.categoryId);
  }

  if (data.tags && data.tags.length > 0) {
    await setBookTags(bookId, data.tags);
  }

  return book!;
}

/**
 * Update a book.
 * @param authorId - The author's profile ID
 * @param id - Book ID
 * @param data - Fields to update
 * @returns Updated book
 */
export async function updateBook(authorId: string, id: string, data: UpdateBookInput): Promise<Book> {
  const [existing] = await db
    .select()
    .from(books)
    .where(and(eq(books.id, id), isNull(books.deletedAt)))
    .limit(1);

  if (!existing || existing.authorId !== authorId) {
    throw new NotFoundError('Book not found');
  }

  const updates: Partial<NewBook> = { updatedAt: new Date() };

  if (data.title !== undefined) {
    updates.title = data.title;
    if (data.slug === undefined && existing.status !== 'published') {
      updates.slug = await ensureUniqueBookSlug(authorId, generateSlug(data.title), id);
    }
  }

  if (data.slug !== undefined) {
    updates.slug = await ensureUniqueBookSlug(authorId, data.slug, id);
  }

  if (data.description !== undefined) {
    updates.description = data.description;
  }

  if (data.coverImageUrl !== undefined) {
    updates.coverImageUrl = data.coverImageUrl;
  }

  await db
    .update(books)
    .set(updates)
    .where(eq(books.id, id));

  if (data.categoryId !== undefined) {
    if (data.categoryId) {
      await setBookCategory(id, data.categoryId);
    } else {
      await removeBookCategory(id);
    }
  }

  if (data.tags !== undefined) {
    if (data.tags.length > 0) {
      await setBookTags(id, data.tags);
    } else {
      await removeBookTags(id);
    }
  }

  const [updated] = await db
    .select()
    .from(books)
    .where(eq(books.id, id))
    .limit(1);

  return updated!;
}

/**
 * Publish a book.
 * @param authorId - The author's profile ID
 * @param id - Book ID
 * @returns Published book with authorship
 */
export async function publishBook(authorId: string, id: string): Promise<Book> {
  const [existing] = await db
    .select()
    .from(books)
    .where(and(eq(books.id, id), isNull(books.deletedAt)))
    .limit(1);

  if (!existing || existing.authorId !== authorId) {
    throw new NotFoundError('Book not found');
  }

  if (existing.status === 'published') {
    throw new ValidationError('Book is already published');
  }

  const chapters = await db
    .select({ id: bookChapters.id })
    .from(bookChapters)
    .where(eq(bookChapters.bookId, id))
    .limit(1);

  if (chapters.length === 0) {
    throw new ValidationError('At least one chapter is required to publish');
  }

  const cat = await getBookCategory(id);
  if (!cat) {
    throw new ValidationError('A category is required to publish a book');
  }

  const profileResult = await db
    .select()
    .from(profiles)
    .where(eq(profiles.id, authorId))
    .limit(1);

  if (profileResult.length === 0) {
    throw new NotFoundError('Profile not found');
  }

  const profile = profileResult[0]!;

  if (existing.toc === null) {
    await regenerateToc(id);
  }

  const [updatedBook] = await db
    .select()
    .from(books)
    .where(eq(books.id, id))
    .limit(1);

  const bookToSign = updatedBook!;
  const contentString = JSON.stringify({
    title: bookToSign.title,
    description: bookToSign.description,
    author: profile.username,
  });

  const signed = await signDocument(profile.userId, contentString);

  const authorship: Authorship = {
    authorName: profile.displayName ?? profile.username,
    username: profile.username,
    documentHash: signed.documentHash,
    publicIdentifier: signed.publicIdentifier,
    hmac: signed.signature,
    signedAt: new Date().toISOString(),
  };

  const now = new Date();
  await db
    .update(books)
    .set({
      status: 'published',
      authorship,
      updatedAt: now,
    })
    .where(eq(books.id, id));

  const [finalBook] = await db
    .select()
    .from(books)
    .where(eq(books.id, id))
    .limit(1);

  return finalBook!;
}

/**
 * Soft delete a book.
 * @param authorId - The author's profile ID
 * @param id - Book ID
 */
export async function softDeleteBook(authorId: string, id: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(books)
    .where(and(eq(books.id, id), isNull(books.deletedAt)))
    .limit(1);

  if (!existing || existing.authorId !== authorId) {
    throw new NotFoundError('Book not found');
  }

  await db
    .update(books)
    .set({ deletedAt: new Date() })
    .where(eq(books.id, id));
}

export interface BookCard {
  id: string;
  title: string;
  description: string | null;
  coverImageUrl: string | null;
  slug: string;
  status: string;
  author: {
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  chapterCount: number;
  category: { id: string; name: string; slug: string } | null;
  tags: { id: string; name: string; slug: string }[];
  updatedAt: Date;
  createdAt: Date;
}

/**
 * Get all books for an author.
 * @param authorId - The author's profile ID
 * @returns Array of book cards
 */
export async function getMyBooks(authorId: string): Promise<BookCard[]> {
  const results = await db
    .select({
      id: books.id,
      title: books.title,
      description: books.description,
      coverImageUrl: books.coverImageUrl,
      slug: books.slug,
      status: books.status,
      username: profiles.username,
      displayName: profiles.displayName,
      avatarUrl: profiles.avatarUrl,
      updatedAt: books.updatedAt,
      createdAt: books.createdAt,
      chapterCount: count(bookChapters.id),
    })
    .from(books)
    .innerJoin(profiles, eq(books.authorId, profiles.id))
    .leftJoin(bookChapters, eq(books.id, bookChapters.bookId))
    .where(and(eq(books.authorId, authorId), isNull(books.deletedAt)))
    .groupBy(books.id, profiles.id)
    .orderBy(desc(books.updatedAt));

  const cards: BookCard[] = [];
  for (const r of results) {
    const [cat] = await db
      .select({ id: categories.id, name: categories.name, slug: categories.slug })
      .from(bookCategory)
      .innerJoin(categories, eq(bookCategory.categoryId, categories.id))
      .where(eq(bookCategory.bookId, r.id))
      .limit(1);

    const tags = await getBookTags(r.id);

    cards.push({
      id: r.id,
      title: r.title,
      description: r.description,
      coverImageUrl: r.coverImageUrl,
      slug: r.slug,
      status: r.status,
      author: {
        username: r.username,
        displayName: r.displayName,
        avatarUrl: r.avatarUrl,
      },
      chapterCount: Number(r.chapterCount ?? 0),
      category: cat ?? null,
      tags,
      updatedAt: r.updatedAt,
      createdAt: r.createdAt,
    });
  }

  return cards;
}

/**
 * Add a chapter to a book.
 * @param authorId - The author's profile ID
 * @param bookId - Book ID
 * @param data - Chapter data
 * @returns Created chapter
 */
export async function addChapter(authorId: string, bookId: string, data: AddChapterInput): Promise<BookChapter> {
  const [book] = await db
    .select()
    .from(books)
    .where(and(eq(books.id, bookId), isNull(books.deletedAt)))
    .limit(1);

  if (!book || book.authorId !== authorId) {
    throw new NotFoundError('Book not found');
  }

  if (book.status === 'published') {
    throw new ValidationError('Cannot add chapters to a published book');
  }

  const [doc] = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, data.documentId),
        eq(documents.status, 'published'),
        eq(documents.authorId, authorId),
        isNull(documents.deletedAt)
      )
    )
    .limit(1);

  if (!doc) {
    throw new ValidationError('Document not found, not published, or not owned by you');
  }

  const [existing] = await db
    .select({ id: bookChapters.id })
    .from(bookChapters)
    .where(and(eq(bookChapters.bookId, bookId), eq(bookChapters.documentId, data.documentId)))
    .limit(1);

  if (existing) {
    throw new ConflictError('Document is already a chapter in this book');
  }

  let position: number;
  if (data.position !== undefined) {
    position = data.position;
    await db
      .update(bookChapters)
      .set({ position: bookChapters.position })
      .where(and(eq(bookChapters.bookId, bookId), sql`${bookChapters.position} >= ${position}`));
  } else {
    const [maxPos] = await db
      .select({ max: sql<number>`MAX(${bookChapters.position})` })
      .from(bookChapters)
      .where(eq(bookChapters.bookId, bookId))
      .limit(1);
    position = (maxPos?.max ?? 0) + 1;
  }

  const now = new Date();
  const [chapter] = await db
    .insert(bookChapters)
    .values({
      id: createId(),
      bookId,
      documentId: data.documentId,
      position,
      introText: data.introText ?? null,
      outroText: data.outroText ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await regenerateToc(bookId);

  return chapter!;
}

/**
 * Update a chapter.
 * @param authorId - The author's profile ID
 * @param chapterId - Chapter ID
 * @param data - Fields to update
 * @returns Updated chapter
 */
export async function updateChapter(
  authorId: string,
  chapterId: string,
  data: UpdateChapterInput
): Promise<BookChapter> {
  const [chapter] = await db
    .select()
    .from(bookChapters)
    .innerJoin(books, eq(bookChapters.bookId, books.id))
    .where(and(eq(bookChapters.id, chapterId), isNull(books.deletedAt)))
    .limit(1);

  if (!chapter || chapter.books.authorId !== authorId) {
    throw new NotFoundError('Chapter not found');
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (data.introText !== undefined) {
    updates.introText = data.introText;
  }

  if (data.outroText !== undefined) {
    updates.outroText = data.outroText;
  }

  if (data.position !== undefined) {
    const oldPos = chapter.book_chapters.position;
    const newPos = data.position;

    if (oldPos !== newPos) {
      await db.transaction(async (tx) => {
        if (newPos > oldPos) {
          await tx
            .update(bookChapters)
            .set({ position: sql`${bookChapters.position} - 1` })
            .where(
              and(
                eq(bookChapters.bookId, chapter.book_chapters.bookId),
                sql`${bookChapters.position} > ${oldPos}`,
                sql`${bookChapters.position} <= ${newPos}`
              )
            );
        } else {
          await tx
            .update(bookChapters)
            .set({ position: sql`${bookChapters.position} + 1` })
            .where(
              and(
                eq(bookChapters.bookId, chapter.book_chapters.bookId),
                sql`${bookChapters.position} >= ${newPos}`,
                sql`${bookChapters.position} < ${oldPos}`
              )
            );
        }
        await tx
          .update(bookChapters)
          .set({ position: newPos, updatedAt: new Date() })
          .where(eq(bookChapters.id, chapterId));
      });

      await regenerateToc(chapter.book_chapters.bookId);

      const [updated] = await db
        .select()
        .from(bookChapters)
        .where(eq(bookChapters.id, chapterId))
        .limit(1);

      return updated!;
    }
  }

  await db
    .update(bookChapters)
    .set(updates)
    .where(eq(bookChapters.id, chapterId));

  const [updated] = await db
    .select()
    .from(bookChapters)
    .where(eq(bookChapters.id, chapterId))
    .limit(1);

  return updated!;
}

/**
 * Remove a chapter from a book.
 * @param authorId - The author's profile ID
 * @param chapterId - Chapter ID
 */
export async function removeChapter(authorId: string, chapterId: string): Promise<void> {
  const [chapter] = await db
    .select()
    .from(bookChapters)
    .innerJoin(books, eq(bookChapters.bookId, books.id))
    .where(and(eq(bookChapters.id, chapterId), isNull(books.deletedAt)))
    .limit(1);

  if (!chapter || chapter.books.authorId !== authorId) {
    throw new NotFoundError('Chapter not found');
  }

  if (chapter.books.status === 'published') {
    throw new ValidationError('Cannot remove chapters from a published book');
  }

  const bookId = chapter.book_chapters.bookId;
  const removedPos = chapter.book_chapters.position;

  await db.transaction(async (tx) => {
    await tx
      .delete(bookChapterProgress)
      .where(eq(bookChapterProgress.chapterId, chapterId));

    await tx
      .delete(bookChapters)
      .where(eq(bookChapters.id, chapterId));

    await tx
      .update(bookChapters)
      .set({ position: sql`${bookChapters.position} - 1` })
      .where(
        and(
          eq(bookChapters.bookId, bookId),
          sql`${bookChapters.position} > ${removedPos}`
        )
      );
  });

  await regenerateToc(bookId);
}

/**
 * Reorder chapters in a book.
 * @param authorId - The author's profile ID
 * @param bookId - Book ID
 * @param data - Array of chapter id/position pairs
 */
export async function reorderChapters(authorId: string, bookId: string, data: ReorderChaptersInput): Promise<void> {
  const [book] = await db
    .select()
    .from(books)
    .where(and(eq(books.id, bookId), isNull(books.deletedAt)))
    .limit(1);

  if (!book || book.authorId !== authorId) {
    throw new NotFoundError('Book not found');
  }

  const chapterIds = data.chapters.map((c) => c.id);
  const existing = await db
    .select({ id: bookChapters.id })
    .from(bookChapters)
    .where(eq(bookChapters.bookId, bookId));

  const existingIds = new Set(existing.map((c) => c.id));
  for (const id of chapterIds) {
    if (!existingIds.has(id)) {
      throw new NotFoundError(`Chapter ${id} not found in this book`);
    }
  }

  await db.transaction(async (tx) => {
    for (const ch of data.chapters) {
      await tx
        .update(bookChapters)
        .set({ position: ch.position, updatedAt: new Date() })
        .where(eq(bookChapters.id, ch.id));
    }
  });

  await regenerateToc(bookId);
}

/**
 * Update the table of contents manually.
 * @param authorId - The author's profile ID
 * @param bookId - Book ID
 * @param data - New TOC data
 * @returns Updated book
 */
export async function updateToc(authorId: string, bookId: string, data: UpdateTocInput): Promise<Book> {
  const [book] = await db
    .select()
    .from(books)
    .where(and(eq(books.id, bookId), isNull(books.deletedAt)))
    .limit(1);

  if (!book || book.authorId !== authorId) {
    throw new NotFoundError('Book not found');
  }

  await db
    .update(books)
    .set({ toc: data.toc, updatedAt: new Date() })
    .where(eq(books.id, bookId));

  const [updated] = await db
    .select()
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);

  return updated!;
}

export interface BookFeedParams {
  cursor?: string;
  limit?: number;
  category?: string;
  tag?: string;
  q?: string;
  sort?: 'recent' | 'popular';
}

export interface BookFeedResult {
  items: BookCard[];
  nextCursor: string | null;
  total: number;
}

/**
 * Get public feed of published books with cursor-based pagination.
 * @param params - Feed parameters
 * @returns Feed result with items, nextCursor, and total
 */
export async function getPublicBookFeed(params: BookFeedParams): Promise<BookFeedResult> {
  const limit = Math.min(params.limit ?? 20, 50);
  const conditions: ReturnType<typeof eq>[] = [];

  conditions.push(eq(books.status, 'published'));
  conditions.push(isNull(books.deletedAt));

  if (params.cursor) {
    const { timestamp: publishedAt, id } = decodeCursor(params.cursor);
    conditions.push(sql`${books.updatedAt} < ${publishedAt}`);
  }

  let results = await db
    .select({
      id: books.id,
      title: books.title,
      description: books.description,
      coverImageUrl: books.coverImageUrl,
      slug: books.slug,
      status: books.status,
      username: profiles.username,
      displayName: profiles.displayName,
      avatarUrl: profiles.avatarUrl,
      updatedAt: books.updatedAt,
      createdAt: books.createdAt,
      chapterCount: count(bookChapters.id),
    })
    .from(books)
    .innerJoin(profiles, eq(books.authorId, profiles.id))
    .leftJoin(bookChapters, eq(books.id, bookChapters.bookId))
    .where(and(...conditions))
    .groupBy(books.id, profiles.id)
    .orderBy(desc(books.updatedAt), desc(books.id))
    .limit(limit + 1);

  if (params.q) {
    const pattern = `%${params.q}%`;
    results = await db
      .select({
        id: books.id,
        title: books.title,
        description: books.description,
        coverImageUrl: books.coverImageUrl,
        slug: books.slug,
        status: books.status,
        username: profiles.username,
        displayName: profiles.displayName,
        avatarUrl: profiles.avatarUrl,
        updatedAt: books.updatedAt,
        createdAt: books.createdAt,
        chapterCount: count(bookChapters.id),
      })
      .from(books)
      .innerJoin(profiles, eq(books.authorId, profiles.id))
      .leftJoin(bookChapters, eq(books.id, bookChapters.bookId))
      .where(
        and(
          ...conditions,
          sql`(${books.title} ILIKE ${pattern} OR ${books.description} ILIKE ${pattern})`
        )
      )
      .groupBy(books.id, profiles.id)
      .orderBy(desc(books.updatedAt), desc(books.id))
      .limit(limit + 1);
  }

  const hasMore = results.length > limit;
  if (hasMore) {
    results.pop();
  }

  const items: BookCard[] = [];
  for (const r of results) {
    const [cat] = await db
      .select({ id: categories.id, name: categories.name, slug: categories.slug })
      .from(bookCategory)
      .innerJoin(categories, eq(bookCategory.categoryId, categories.id))
      .where(eq(bookCategory.bookId, r.id))
      .limit(1);

    const tags = await getBookTags(r.id);

    items.push({
      id: r.id,
      title: r.title,
      description: r.description,
      coverImageUrl: r.coverImageUrl,
      slug: r.slug,
      status: r.status,
      author: {
        username: r.username,
        displayName: r.displayName,
        avatarUrl: r.avatarUrl,
      },
      chapterCount: Number(r.chapterCount ?? 0),
      category: cat ?? null,
      tags,
      updatedAt: r.updatedAt,
      createdAt: r.createdAt,
    });
  }

  const lastResult = results[results.length - 1];
  const nextCursor = hasMore && lastResult
    ? encodeCursor(lastResult.updatedAt, lastResult.id)
    : null;

  const totalResult = await db
    .select({ count: count() })
    .from(books)
    .innerJoin(profiles, eq(books.authorId, profiles.id))
    .where(and(...conditions));

  const total = Number(totalResult[0]?.count ?? 0);

  return { items, nextCursor, total };
}

export interface BookFull {
  id: string;
  title: string;
  description: string | null;
  coverImageUrl: string | null;
  slug: string;
  status: string;
  author: {
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  category: { id: string; name: string; slug: string } | null;
  tags: { id: string; name: string; slug: string }[];
  toc: unknown;
  authorship: Authorship;
  chapters: {
    id: string;
    position: number;
    introText: string | null;
    outroText: string | null;
    document: {
      id: string;
      title: string;
      abstract: string | null;
      slug: string;
    };
    progress?: {
      isRead: boolean;
      readAt: Date | null;
    };
  }[];
  progress?: {
    lastChapterId: string | null;
  };
}

/**
 * Get a full public book by username and slug.
 * @param username - The author's username
 * @param slug - The book's slug
 * @param profileId - The authenticated user's profile ID
 * @returns Full book with chapters and progress
 */
export async function getPublicBook(username: string, slug: string, profileId: string): Promise<BookFull> {
  const [book] = await db
    .select({
      id: books.id,
      title: books.title,
      description: books.description,
      coverImageUrl: books.coverImageUrl,
      slug: books.slug,
      status: books.status,
      username: profiles.username,
      displayName: profiles.displayName,
      avatarUrl: profiles.avatarUrl,
      authorship: books.authorship,
      toc: books.toc,
    })
    .from(books)
    .innerJoin(profiles, eq(books.authorId, profiles.id))
    .innerJoin(users, eq(profiles.userId, users.id))
    .where(
      and(
        matchUsername(profiles.username, username),
        eq(books.slug, slug),
        eq(books.status, 'published'),
        isNull(books.deletedAt),
        isNull(profiles.deletedAt),
        isNull(users.deletedAt)
      )
    )
    .limit(1);

  if (!book) {
    throw new NotFoundError('Book not found');
  }

  const [cat] = await db
    .select({ id: categories.id, name: categories.name, slug: categories.slug })
    .from(bookCategory)
    .innerJoin(categories, eq(bookCategory.categoryId, categories.id))
    .where(eq(bookCategory.bookId, book.id))
    .limit(1);

  const tags = await getBookTags(book.id);

  const chapters = await db
    .select({
      id: bookChapters.id,
      position: bookChapters.position,
      introText: bookChapters.introText,
      outroText: bookChapters.outroText,
      documentId: documents.id,
      documentTitle: documents.title,
      documentAbstract: documents.abstract,
      documentSlug: documents.slug,
    })
    .from(bookChapters)
    .innerJoin(documents, eq(bookChapters.documentId, documents.id))
    .where(eq(bookChapters.bookId, book.id))
    .orderBy(bookChapters.position);

  let userProgress: BookProgress | null = null;
  const [bp] = await db
    .select()
    .from(bookProgress)
    .where(and(eq(bookProgress.bookId, book.id), eq(bookProgress.profileId, profileId)))
    .limit(1);
  userProgress = bp ?? null;

  const chapterProgressMap = new Map<string, { isRead: boolean; readAt: Date | null }>();
  if (chapters.length > 0) {
    const chapterIds = chapters.map((c) => c.id);
    const progressRows = await db
      .select()
      .from(bookChapterProgress)
      .where(
        and(
          eq(bookChapterProgress.profileId, profileId),
          sql`${bookChapterProgress.chapterId} IN (${sql.join(chapterIds.map((id) => sql`${id}`), sql`, `)})`
        )
      );

    for (const row of progressRows) {
      chapterProgressMap.set(row.chapterId, {
        isRead: row.isRead,
        readAt: row.readAt,
      });
    }
  }

  const result: BookFull = {
    id: book.id,
    title: book.title,
    description: book.description,
    coverImageUrl: book.coverImageUrl,
    slug: book.slug,
    status: book.status,
    author: {
      username: book.username,
      displayName: book.displayName,
      avatarUrl: book.avatarUrl,
    },
    category: cat ?? null,
    tags,
    toc: book.toc,
    authorship: stripLegacyUserHash(book.authorship),
    chapters: chapters.map((c) => ({
      id: c.id,
      position: c.position,
      introText: c.introText,
      outroText: c.outroText,
      document: {
        id: c.documentId,
        title: c.documentTitle,
        abstract: c.documentAbstract,
        slug: c.documentSlug,
      },
      progress: chapterProgressMap.get(c.id),
    })),
    progress: userProgress
      ? { lastChapterId: userProgress.lastChapterId }
      : undefined,
  };

  return result;
}

/**
 * Update reading progress for a user on a book.
 * @param profileId - The profile ID
 * @param bookId - Book ID
 * @param chapterId - Chapter ID that was read
 */
export async function updateProgress(profileId: string, bookId: string, chapterId: string): Promise<void> {
  const [book] = await db
    .select({ id: books.id })
    .from(books)
    .where(and(eq(books.id, bookId), eq(books.status, 'published'), isNull(books.deletedAt)))
    .limit(1);

  if (!book) {
    throw new NotFoundError('Book not found');
  }

  const [chapter] = await db
    .select({ id: bookChapters.id })
    .from(bookChapters)
    .where(and(eq(bookChapters.id, chapterId), eq(bookChapters.bookId, bookId)))
    .limit(1);

  if (!chapter) {
    throw new NotFoundError('Chapter not found');
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    const [existingProgress] = await tx
      .select()
      .from(bookProgress)
      .where(and(eq(bookProgress.profileId, profileId), eq(bookProgress.bookId, bookId)))
      .limit(1);

    if (existingProgress) {
      await tx
        .update(bookProgress)
        .set({ lastChapterId: chapterId, updatedAt: now })
        .where(eq(bookProgress.id, existingProgress.id));
    } else {
      await tx.insert(bookProgress).values({
        id: createId(),
        profileId,
        bookId,
        lastChapterId: chapterId,
        createdAt: now,
        updatedAt: now,
      });
    }

    const [existingChapterProgress] = await tx
      .select()
      .from(bookChapterProgress)
      .where(and(eq(bookChapterProgress.profileId, profileId), eq(bookChapterProgress.chapterId, chapterId)))
      .limit(1);

    if (existingChapterProgress) {
      await tx
        .update(bookChapterProgress)
        .set({ isRead: true, readAt: now })
        .where(eq(bookChapterProgress.id, existingChapterProgress.id));
    } else {
      await tx.insert(bookChapterProgress).values({
        id: createId(),
        profileId,
        chapterId,
        isRead: true,
        readAt: now,
      });
    }
  });
}
