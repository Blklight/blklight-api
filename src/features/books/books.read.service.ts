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
  BookProgress,
} from './books.schema';
import { profiles } from '../profiles/profiles.schema';
import { documents } from '../documents/documents.schema';
import { categories } from '../categories/categories.schema';
import { tags as tagsTable } from '../tags/tags.schema';
import { users } from '../auth/auth.schema';
import { NotFoundError } from '../../utils/errors';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { matchUsername } from '../../utils/username';
import type { Authorship, BookCard } from './books.service';

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

export async function getBookTags(bookId: string): Promise<{ id: string; name: string; slug: string }[]> {
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
