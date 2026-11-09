import { eq, and, isNull, desc, ne } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { db } from '../../db/index';
import { documents, documentTypes, documentStyles, NewDocument, NewDocumentStyle } from './documents.schema';
import { profiles } from '../profiles/profiles.schema';
import { documentTags } from '../tags/tags.schema';
import { signDocument } from '../signatures/signatures.service';
import { ValidationError, NotFoundError } from '../../utils/errors';
import { generateSlug, resolveUniqueSlug } from '../../utils/slug';
import { getDocumentTags, setDocumentTags } from '../tags/tags.service';
import { getDocumentCategory, setDocumentCategory, removeDocumentCategory } from '../categories/categories.service';
import {
  resolveOrganizationForAuthor,
  assertOrganizationPublishAccess,
  findOrganizationByReference,
  mapOrganization,
  type OrganizationRef,
} from '../organizations/organizations.service';
import { organizations } from '../organizations/organizations.schema';
import type { CreateDocumentInput, UpdateDocumentInput } from './documents.zod';

export interface DocumentWithStyle {
  id: string;
  authorId: string;
  typeId: string;
  typeName: string;
  status: string;
  title: string;
  abstract: string | null;
  content: Record<string, unknown> | null;
  coverImageUrl: string | null;
  slug: string;
  authorship: Authorship | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  organization: OrganizationRef | null;
  style: {
    typography: string;
    paperStyle: Record<string, unknown> | null;
    paperTexture: Record<string, unknown> | null;
    coverSettings: Record<string, unknown> | null;
    documentHeader: Record<string, unknown> | null;
    documentFooter: Record<string, unknown> | null;
    documentSignature: Record<string, unknown> | null;
  };
}

export { type OrganizationRef } from '../organizations/organizations.service';

export interface MyDocumentDetail extends DocumentWithStyle {
  category: { id: string; name: string; slug: string } | null;
  tags: { id: string; name: string; slug: string }[];
}

export interface DocumentSummary {
  id: string;
  title: string;
  abstract: string | null;
  status: string;
  typeName: string;
  slug: string;
  coverImageUrl: string | null;
  authorship: Authorship | null;
  publishedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
  organization: OrganizationRef | null;
}

export interface Authorship {
  authorName: string;
  username: string;
  documentHash: string;
  publicIdentifier: string;
  hmac: string;
  signedAt: string;
}

async function isDocumentSlugTaken(authorId: string, slug: string, excludeId?: string): Promise<boolean> {
  const conditions = [
    eq(documents.authorId, authorId),
    eq(documents.slug, slug),
  ];

  if (excludeId) {
    conditions.push(ne(documents.id, excludeId));
  }

  const existing = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(...conditions))
    .limit(1);

  return existing.length > 0;
}

function getDefaultStyles(typeName: string): Partial<NewDocumentStyle> {
  const base = {
    typography: 'sans' as const,
    paperStyle: null,
    paperTexture: null,
    coverSettings: null,
    documentHeader: null,
    documentFooter: null,
    documentSignature: null,
  };

  if (typeName === 'article') {
    return {
      ...base,
      typography: 'serif',
      paperStyle: {},
      documentHeader: {},
      documentFooter: {},
    };
  }

  if (typeName === 'page') {
    return {
      ...base,
      typography: 'mono',
    };
  }

  return base;
}

/**
 * Resolve the organization a document should be linked to on write.
 * @param reference - The organization id or orgname sent by the client
 * @param authorProfileId - The author's profile ID
 * @returns The resolved organization id, or null when the link must be cleared
 * @throws NotFoundError if the organization does not exist or is private and the author is not a member
 * @throws ForbiddenError if the author is not an accepted member of a visible organization
 */
async function resolveOrganizationIdForWrite(
  reference: string | null | undefined,
  authorProfileId: string
): Promise<string | null> {
  if (reference === undefined || reference === null) {
    return null;
  }

  const org = await resolveOrganizationForAuthor(reference, authorProfileId);
  return org.id;
}

/**
 * Resolve the organization link of an update.
 *
 * Clearing the link is always allowed for the author. Pointing the document
 * at another organization requires an accepted membership on that
 * organization: a missing organization and a private one the author cannot
 * see both answer 404, a visible one answers 403.
 *
 * The membership is only revalidated when the value actually changes, so an
 * autosave that resends the current organization keeps working for an author
 * who was removed from it in the meantime.
 * @param reference - The organization id or orgname sent by the client, or null to clear the link
 * @param currentOrganizationId - The organization the document is linked to today
 * @param authorProfileId - The author's profile ID
 * @returns The organization id to store, or null when the link is cleared
 * @throws NotFoundError if the organization does not exist or is private and the author is not a member
 * @throws ForbiddenError if the author is not an accepted member of a visible organization
 */
async function resolveOrganizationIdForUpdate(
  reference: string | null,
  currentOrganizationId: string | null,
  authorProfileId: string
): Promise<string | null> {
  if (reference === null) {
    return null;
  }

  const target = await findOrganizationByReference(reference);

  if (currentOrganizationId !== null && target !== null && target.id === currentOrganizationId) {
    return currentOrganizationId;
  }

  const org = await resolveOrganizationForAuthor(reference, authorProfileId);
  return org.id;
}

export async function createDocument(
  authorId: string,
  data: CreateDocumentInput
): Promise<DocumentWithStyle> {
  const typeResult = await db
    .select()
    .from(documentTypes)
    .where(eq(documentTypes.name, data.type))
    .limit(1);

  if (typeResult.length === 0) {
    throw new ValidationError('Invalid document type');
  }

  const type = typeResult[0]!;
  const baseSlug = data.slug ?? generateSlug(data.title);
  const slug = await resolveUniqueSlug(baseSlug, (candidate) => isDocumentSlugTaken(authorId, candidate));
  const now = new Date();
  const documentId = createId();
  const organizationId = await resolveOrganizationIdForWrite(data.organizationId, authorId);

  await db.transaction(async (tx) => {
    const newDocument: NewDocument = {
      id: documentId,
      authorId,
      typeId: type.id,
      title: data.title,
      abstract: data.abstract ?? null,
      content: data.content ?? null,
      coverImageUrl: data.coverImageUrl ?? null,
      slug,
      status: 'draft',
      organizationId,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(documents).values(newDocument);

    const defaultStyles = getDefaultStyles(data.type);
    const newStyle: NewDocumentStyle = {
      id: createId(),
      documentId,
      typography: defaultStyles.typography ?? 'sans',
      paperStyle: defaultStyles.paperStyle ?? null,
      paperTexture: defaultStyles.paperTexture ?? null,
      coverSettings: defaultStyles.coverSettings ?? null,
      documentHeader: defaultStyles.documentHeader ?? null,
      documentFooter: defaultStyles.documentFooter ?? null,
      documentSignature: defaultStyles.documentSignature ?? null,
      updatedAt: now,
    };
    await tx.insert(documentStyles).values(newStyle);

    // The category and the tags belong to the same unit of work as the
    // document: an unknown categoryId must not leave a half-created draft
    // behind, so the whole write rolls back together.
    if (data.categoryId) {
      await setDocumentCategory(documentId, data.categoryId, tx);
    }

    if (data.tags && data.tags.length > 0) {
      await setDocumentTags(documentId, data.tags, tx);
    }
  });

  return getDocumentById(documentId, authorId);
}

export async function updateDocument(
  authorId: string,
  documentId: string,
  data: UpdateDocumentInput
): Promise<DocumentWithStyle> {
  const doc = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
    .limit(1);

  if (doc.length === 0 || doc[0]!.authorId !== authorId) {
    throw new NotFoundError('Document not found');
  }

  const existingDoc = doc[0]!;
  const now = new Date();
  const updates: Partial<NewDocument> = { updatedAt: now };
  const styleUpdates: Record<string, unknown> = { updatedAt: now };

  if (data.title !== undefined) {
    updates.title = data.title;
    if (data.slug === undefined && existingDoc.status !== 'published') {
      updates.slug = await resolveUniqueSlug(generateSlug(data.title), (candidate) =>
        isDocumentSlugTaken(authorId, candidate, documentId)
      );
    }
  }

  if (data.slug !== undefined) {
    updates.slug = await resolveUniqueSlug(data.slug, (candidate) =>
      isDocumentSlugTaken(authorId, candidate, documentId)
    );
  }

  if (data.abstract !== undefined) {
    updates.abstract = data.abstract;
  }

  if (data.coverImageUrl !== undefined) {
    updates.coverImageUrl = data.coverImageUrl;
  }

  if (data.type !== undefined) {
    const typeResult = await db
      .select()
      .from(documentTypes)
      .where(eq(documentTypes.name, data.type))
      .limit(1);

    if (typeResult.length === 0) {
      throw new ValidationError('Invalid document type');
    }
    updates.typeId = typeResult[0]!.id;
  }

  // The organization link is mutable, on a draft and on a published document
  // alike: what is enforced is that the author may point the document at the
  // target organization. Clearing it is always allowed, and a value equal to
  // the current one is accepted without revalidating the membership, so an
  // autosave never fails for an author who lost the membership.
  if (data.organizationId !== undefined) {
    updates.organizationId = await resolveOrganizationIdForUpdate(
      data.organizationId,
      existingDoc.organizationId,
      authorId
    );
  }

  // Decisão de produto: editar o content de um doc published NÃO reseta
  // para draft nem invalida authorship. authorship é metadado imutável
  // de "quem publicou e quando, sobre o conteúdo daquele momento" — não
  // é (e nunca foi, em produção) uma prova de integridade ativa: nenhum
  // fluxo recomputa/valida documentHash contra o conteúdo atual em tempo
  // de leitura (verifyDocument existe mas não é chamado fora de testes
  // unitários). Se um dia a verificação de integridade for reativada
  // (ex: endpoint público de autenticidade), este comportamento precisa
  // ser revisitado — authorship ficará stale em relação a edições feitas
  // após a publicação original.
  if (data.content !== undefined) {
    updates.content = data.content;
  }

  if (data.typography !== undefined) {
    styleUpdates.typography = data.typography;
  }
  if (data.paperStyle !== undefined) {
    styleUpdates.paperStyle = data.paperStyle;
  }
  if (data.paperTexture !== undefined) {
    styleUpdates.paperTexture = data.paperTexture;
  }
  if (data.coverSettings !== undefined) {
    styleUpdates.coverSettings = data.coverSettings;
  }
  if (data.documentHeader !== undefined) {
    styleUpdates.documentHeader = data.documentHeader;
  }
  if (data.documentFooter !== undefined) {
    styleUpdates.documentFooter = data.documentFooter;
  }
  if (data.documentSignature !== undefined) {
    styleUpdates.documentSignature = data.documentSignature;
  }

  await db.transaction(async (tx) => {
    await tx.update(documents).set(updates).where(eq(documents.id, documentId));

    if (Object.keys(styleUpdates).length > 1) {
      await tx.update(documentStyles).set(styleUpdates).where(eq(documentStyles.documentId, documentId));
    }

    // The category and the tags belong to the same unit of work as the
    // document fields: an unknown categoryId must not leave the document
    // half-updated, so the whole write rolls back together.
    if (data.categoryId !== undefined) {
      if (data.categoryId) {
        await setDocumentCategory(documentId, data.categoryId, tx);
      } else {
        await removeDocumentCategory(documentId, tx);
      }
    }

    if (data.tags !== undefined) {
      if (data.tags.length > 0) {
        await setDocumentTags(documentId, data.tags, tx);
      } else {
        await tx.delete(documentTags).where(eq(documentTags.documentId, documentId));
      }
    }
  });

  return getDocumentById(documentId, authorId);
}

export async function publishDocument(
  authorId: string,
  documentId: string
): Promise<DocumentWithStyle> {
  const doc = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
    .limit(1);

  if (doc.length === 0 || doc[0]!.authorId !== authorId) {
    throw new NotFoundError('Document not found');
  }

  const existingDoc = doc[0]!;

  if (existingDoc.status === 'published') {
    throw new ValidationError('Document is already published');
  }

  if (!existingDoc.content) {
    throw new ValidationError('Cannot publish empty document');
  }

  const category = await getDocumentCategory(documentId);
  if (!category) {
    throw new ValidationError('A category is required to publish');
  }

  // The organization link is revalidated at publish time: an author who was
  // removed from the organization in the meantime cannot publish the document.
  // The check runs last so the other publish errors keep their precedence.
  if (existingDoc.organizationId) {
    await assertOrganizationPublishAccess(existingDoc.organizationId, authorId);
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
  const contentString = JSON.stringify(existingDoc.content);
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
    .update(documents)
    .set({
      status: 'published',
      authorship,
      publishedAt: now,
      updatedAt: now,
    })
    .where(eq(documents.id, documentId));

  return getDocumentById(documentId, authorId);
}

export async function softDeleteDocument(
  authorId: string,
  documentId: string
): Promise<void> {
  const doc = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
    .limit(1);

  if (doc.length === 0 || doc[0]!.authorId !== authorId) {
    throw new NotFoundError('Document not found');
  }

  await db
    .update(documents)
    .set({ deletedAt: new Date() })
    .where(eq(documents.id, documentId));
}

export async function getMyDocuments(
  authorId: string,
  limit: number = 20,
  offset: number = 0
): Promise<DocumentSummary[]> {
  const results = await db
    .select({
      id: documents.id,
      title: documents.title,
      abstract: documents.abstract,
      status: documents.status,
      typeName: documentTypes.name,
      slug: documents.slug,
      coverImageUrl: documents.coverImageUrl,
      authorship: documents.authorship,
      publishedAt: documents.publishedAt,
      updatedAt: documents.updatedAt,
      createdAt: documents.createdAt,
      organizationId: documents.organizationId,
      organizationOrgname: organizations.orgname,
      organizationName: organizations.name,
      organizationIsPrivate: organizations.isPrivate,
    })
    .from(documents)
    .innerJoin(documentTypes, eq(documents.typeId, documentTypes.id))
    .leftJoin(organizations, eq(documents.organizationId, organizations.id))
    .where(and(eq(documents.authorId, authorId), isNull(documents.deletedAt)))
    .orderBy(desc(documents.updatedAt))
    .limit(limit)
    .offset(offset);

  return results.map((r) => ({
    id: r.id,
    title: r.title,
    abstract: r.abstract,
    status: r.status,
    typeName: r.typeName,
    slug: r.slug,
    coverImageUrl: r.coverImageUrl,
    authorship: r.authorship as Authorship | null,
    publishedAt: r.publishedAt,
    updatedAt: r.updatedAt,
    createdAt: r.createdAt,
    organization: mapOrganization(
      r.organizationId,
      r.organizationOrgname,
      r.organizationName,
      r.organizationIsPrivate,
      authorId,
      authorId
    ),
  }));
}

async function getDocumentStyleMap(documentId: string): Promise<DocumentWithStyle['style']> {
  const styleResult = await db
    .select()
    .from(documentStyles)
    .where(eq(documentStyles.documentId, documentId))
    .limit(1);

  const style = styleResult[0] ?? {
    typography: 'sans',
    paperStyle: null,
    paperTexture: null,
    coverSettings: null,
    documentHeader: null,
    documentFooter: null,
    documentSignature: null,
  };

  return {
    typography: style.typography,
    paperStyle: style.paperStyle as Record<string, unknown> | null,
    paperTexture: style.paperTexture as Record<string, unknown> | null,
    coverSettings: style.coverSettings as Record<string, unknown> | null,
    documentHeader: style.documentHeader as Record<string, unknown> | null,
    documentFooter: style.documentFooter as Record<string, unknown> | null,
    documentSignature: style.documentSignature as Record<string, unknown> | null,
  };
}

async function getDocumentById(documentId: string, authorId: string): Promise<DocumentWithStyle> {
  const docResult = await db
    .select({
      id: documents.id,
      authorId: documents.authorId,
      typeId: documents.typeId,
      typeName: documentTypes.name,
      status: documents.status,
      title: documents.title,
      abstract: documents.abstract,
      content: documents.content,
      coverImageUrl: documents.coverImageUrl,
      slug: documents.slug,
      authorship: documents.authorship,
      publishedAt: documents.publishedAt,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
      organizationId: documents.organizationId,
      organizationOrgname: organizations.orgname,
      organizationName: organizations.name,
      organizationIsPrivate: organizations.isPrivate,
    })
    .from(documents)
    .innerJoin(documentTypes, eq(documents.typeId, documentTypes.id))
    .leftJoin(organizations, eq(documents.organizationId, organizations.id))
    .where(eq(documents.id, documentId))
    .limit(1);

  if (docResult.length === 0 || docResult[0]!.authorId !== authorId) {
    throw new NotFoundError('Document not found');
  }

  const doc = docResult[0]!;
  const style = await getDocumentStyleMap(documentId);

  return {
    ...doc,
    content: doc.content as Record<string, unknown> | null,
    authorship: doc.authorship as Authorship | null,
    organization: mapOrganization(
      doc.organizationId,
      doc.organizationOrgname,
      doc.organizationName,
      doc.organizationIsPrivate,
      authorId,
      authorId
    ),
    style,
  };
}

/**
 * Get a full document owned by the caller, for reopening it in the editor.
 * Draft, published and archived documents are all readable by their owner.
 * @param authorId - The caller's profile ID
 * @param documentId - The document ID
 * @returns The full document with style, category and tags
 * @throws NotFoundError if the document does not exist, is soft-deleted, or belongs to another author
 */
export async function getMyDocumentById(authorId: string, documentId: string): Promise<MyDocumentDetail> {
  const docResult = await db
    .select({
      id: documents.id,
      authorId: documents.authorId,
      typeId: documents.typeId,
      typeName: documentTypes.name,
      status: documents.status,
      title: documents.title,
      abstract: documents.abstract,
      content: documents.content,
      coverImageUrl: documents.coverImageUrl,
      slug: documents.slug,
      authorship: documents.authorship,
      publishedAt: documents.publishedAt,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
      organizationId: documents.organizationId,
      organizationOrgname: organizations.orgname,
      organizationName: organizations.name,
      organizationIsPrivate: organizations.isPrivate,
    })
    .from(documents)
    .innerJoin(documentTypes, eq(documents.typeId, documentTypes.id))
    .leftJoin(organizations, eq(documents.organizationId, organizations.id))
    .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
    .limit(1);

  if (docResult.length === 0 || docResult[0]!.authorId !== authorId) {
    throw new NotFoundError('Document not found');
  }

  const doc = docResult[0]!;

  const [style, category, tags] = await Promise.all([
    getDocumentStyleMap(documentId),
    getDocumentCategory(documentId),
    getDocumentTags(documentId),
  ]);

  return {
    ...doc,
    content: doc.content as Record<string, unknown> | null,
    authorship: doc.authorship as Authorship | null,
    organization: mapOrganization(
      doc.organizationId,
      doc.organizationOrgname,
      doc.organizationName,
      doc.organizationIsPrivate,
      authorId,
      authorId
    ),
    style,
    category: category ? { id: category.id, name: category.name, slug: category.slug } : null,
    tags: tags.map((t) => ({ id: t.id, name: t.name, slug: t.slug })),
  };
}

// Public reads (feed, public document, author/organization listings) live in
// documents.read.service; re-exported so importers and test mocks keep one path.
export * from './documents.read.service';
