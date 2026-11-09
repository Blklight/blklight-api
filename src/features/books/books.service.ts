import { eq, and, isNull, desc, count, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { db } from '../../db/index';
import {
  books,
  bookChapters,
  bookCategory,
  bookTags,
  bookChapterProgress,
  Book,
  NewBook,
  BookChapter,
} from './books.schema';
import { profiles } from '../profiles/profiles.schema';
import { documents } from '../documents/documents.schema';
import { categories } from '../categories/categories.schema';
import { normalizeTag, upsertTags } from '../tags/tags.service';
import { signDocument } from '../signatures/signatures.service';
import { ValidationError, NotFoundError, ConflictError } from '../../utils/errors';
import { generateToc, ChapterWithDocument } from '../../utils/toc';
import type {
  CreateBookInput,
  UpdateBookInput,
  AddChapterInput,
  UpdateChapterInput,
  ReorderChaptersInput,
  UpdateTocInput,
} from './books.zod';
import { getBookTags } from './books.read.service';

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

// Public reads (feed, public book) and reading progress live in
// books.read.service; re-exported so importers and test mocks keep one path.
export * from './books.read.service';
