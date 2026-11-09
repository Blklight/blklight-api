import { eq, and, asc, desc, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { db } from '../../db/index';
import {
  organizations,
  organizationMembers,
  Organization,
  OrganizationMember,
} from './organizations.schema';
import { profiles } from '../profiles/profiles.schema';
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from '../../utils/errors';
import type { CreateOrganizationInput } from './organizations.zod';

const ACCEPTED = 'accepted';

/**
 * The organization a document belongs to, as exposed on reads.
 */
export interface OrganizationRef {
  id: string;
  orgname: string;
  name: string;
}

/**
 * Map the organization of a document to the shape exposed on reads.
 * A private organization is only revealed to the document's own author, so
 * its existence is never leaked through a public read. A document keeps the
 * link even when its author later leaves the organization.
 * @param orgId - The organization ID stored on the document (null when unlinked)
 * @param orgname - The organization orgname
 * @param name - The organization display name
 * @param isPrivate - Whether the organization is private
 * @param viewerProfileId - The viewer's profile ID, when authenticated
 * @param authorProfileId - The document author's profile ID
 * @returns The organization reference or null
 */
export function mapOrganization(
  orgId: string | null,
  orgname: string | null,
  name: string | null,
  isPrivate: boolean | null,
  viewerProfileId: string | undefined,
  authorProfileId: string
): OrganizationRef | null {
  if (!orgId || !orgname || !name) {
    return null;
  }

  if (isPrivate && viewerProfileId !== authorProfileId) {
    return null;
  }

  return { id: orgId, orgname, name };
}

interface Roles {
  owner: number;
  admin: number;
  member: number;
}

const ROLE_RANK: Roles = { owner: 0, admin: 1, member: 2 };

/**
 * Ensure an organization exists.
 * @param orgId - The organization ID
 * @returns The organization row
 * @throws NotFoundError if organization not found
 */
async function assertOrganizationExists(orgId: string): Promise<Organization> {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) {
    throw new NotFoundError('Organization not found');
  }

  return org;
}

/**
 * Get an organization by its orgname.
 * Public read: returns the org if it is not private, or if the optional
 * profile is an accepted member (private orgs).
 * For private orgs without membership, a NotFoundError is returned so the
 * existence of a private org is never leaked.
 * @param orgname - The org handle
 * @param profileId - Optional profile ID to authorize private org access
 * @returns The organization row
 * @throws NotFoundError if org does not exist or is private and caller is not a member
 */
export async function getOrganizationByOrgname(
  orgname: string,
  profileId?: string | null
): Promise<Organization> {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.orgname, orgname.toLowerCase()))
    .limit(1);

  if (!org) {
    throw new NotFoundError('Organization not found');
  }

  if (!org.isPrivate) {
    return org;
  }

  if (profileId) {
    const member = await getMembership(org.id, profileId);
    if (member?.status === ACCEPTED) {
      return org;
    }
  }

  throw new NotFoundError('Organization not found');
}

/**
 * Find an organization by its id or by its orgname.
 * The id is tried first so a slug-like orgname can never shadow an id.
 * @param reference - The organization id or orgname
 * @returns The organization row or null
 */
export async function findOrganizationByReference(reference: string): Promise<Organization | null> {
  const value = reference.trim();

  if (!value) {
    return null;
  }

  const [byId] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, value))
    .limit(1);

  if (byId) {
    return byId;
  }

  const [byOrgname] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.orgname, value.toLowerCase()))
    .limit(1);

  return byOrgname ?? null;
}

/**
 * Resolve an organization reference for a reader, applying the same
 * visibility rule as getOrganizationByOrgname: a private organization is
 * invisible to non-members, so it answers 404 exactly like a missing one.
 * @param reference - The organization id or orgname
 * @param profileId - Optional profile ID used to authorize private access
 * @returns The organization row
 * @throws NotFoundError if the org does not exist or is private and the caller is not a member
 */
export async function resolveOrganizationForViewer(
  reference: string,
  profileId?: string | null
): Promise<Organization> {
  const org = await findOrganizationByReference(reference);

  if (!org) {
    throw new NotFoundError('Organization not found');
  }

  if (!org.isPrivate) {
    return org;
  }

  if (profileId) {
    const member = await getMembership(org.id, profileId);
    if (member?.status === ACCEPTED) {
      return org;
    }
  }

  throw new NotFoundError('Organization not found');
}

/**
 * Resolve an organization reference for a write performed by a document
 * author. A missing organization and a private organization the author
 * cannot see both answer 404; a visible organization the author is not an
 * accepted member of answers 403.
 * @param reference - The organization id or orgname
 * @param profileId - The author profile ID
 * @returns The organization row
 * @throws NotFoundError if the org does not exist or is private and the author is not a member
 * @throws ForbiddenError if the author is not an accepted member of the org
 */
export async function resolveOrganizationForAuthor(
  reference: string,
  profileId: string
): Promise<Organization> {
  const org = await resolveOrganizationForViewer(reference, profileId);
  await assertAcceptedMember(org.id, profileId);
  return org;
}

/**
 * Ensure a profile is still an accepted member of an organization, used to
 * revalidate the ownership of a document at publish time.
 * @param orgId - The organization ID
 * @param profileId - The profile ID
 * @throws ForbiddenError if the profile is not an accepted member
 */
export async function assertOrganizationPublishAccess(orgId: string, profileId: string): Promise<void> {
  const member = await getMembership(orgId, profileId);

  if (!member || member.status !== ACCEPTED) {
    throw new ForbiddenError('You must be a member of this organization to publish this document');
  }
}

/**
 * Get a profile's membership in an organization.
 * @param orgId - The organization ID
 * @param profileId - The profile ID
 * @returns Membership row or null
 */
async function getMembership(orgId: string, profileId: string): Promise<OrganizationMember | null> {
  const [member] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.profileId, profileId)
      )
    )
    .limit(1);

  return member ?? null;
}

/**
 * Ensure a profile is an accepted member of an organization.
 * @param orgId - The organization ID
 * @param profileId - The profile ID
 * @returns Membership row
 * @throws ForbiddenError if not an accepted member
 */
async function assertAcceptedMember(orgId: string, profileId: string): Promise<OrganizationMember> {
  const member = await getMembership(orgId, profileId);

  if (!member || member.status !== ACCEPTED) {
    throw new ForbiddenError('You must be a member of this organization');
  }

  return member;
}

/**
 * Ensure a profile can manage an organization (owner or admin).
 * @param orgId - The organization ID
 * @param profileId - The profile ID
 * @returns Membership row
 * @throws ForbiddenError if not owner/admin
 */
async function assertManager(orgId: string, profileId: string): Promise<OrganizationMember> {
  const member = await assertAcceptedMember(orgId, profileId);

  if (member.role !== 'owner' && member.role !== 'admin') {
    throw new ForbiddenError('Owner or admin access required');
  }

  return member;
}

/**
 * Check whether an orgname is already taken.
 * @param orgname - The org handle
 * @returns True if taken
 */
async function isOrgnameTaken(orgname: string): Promise<boolean> {
  const existing = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.orgname, orgname))
    .limit(1);

  return existing.length > 0;
}

/**
 * Create an organization.
 * The creator becomes the owner and is added as an accepted member in the
 * same transaction.
 * @param ownerProfileId - The owning profile's ID
 * @param data - Organization data
 * @returns Created organization
 * @throws ConflictError if the orgname is already taken
 */
export async function createOrganization(
  ownerProfileId: string,
  data: CreateOrganizationInput
): Promise<Organization> {
  const orgname = data.orgname.toLowerCase();

  if (await isOrgnameTaken(orgname)) {
    throw new ConflictError('Organization orgname is already in use');
  }

  const org = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(organizations)
      .values({
        id: createId(),
        ownerId: ownerProfileId,
        name: data.name.trim(),
        orgname,
        description: data.description ?? null,
        isPrivate: data.isPrivate ?? false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    await tx.insert(organizationMembers).values({
      id: createId(),
      orgId: created!.id,
      profileId: ownerProfileId,
      role: 'owner',
      status: ACCEPTED,
      invitedBy: ownerProfileId,
      requestedAt: new Date(),
    });

    return created!;
  });

  return org;
}

export interface OrganizationListItem {
  id: string;
  name: string;
  orgname: string;
  description: string | null;
  isPrivate: boolean;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  myRole: string;
}

/**
 * List organizations where the caller is an accepted member.
 * @param profileId - The caller's profile ID
 * @returns List of organizations with the caller's role
 */
export async function listMyOrganizations(profileId: string): Promise<OrganizationListItem[]> {
  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      orgname: organizations.orgname,
      description: organizations.description,
      isPrivate: organizations.isPrivate,
      ownerId: organizations.ownerId,
      createdAt: organizations.createdAt,
      updatedAt: organizations.updatedAt,
      myRole: organizationMembers.role,
    })
    .from(organizations)
    .innerJoin(organizationMembers, eq(organizations.id, organizationMembers.orgId))
    .where(
      and(
        eq(organizationMembers.profileId, profileId),
        eq(organizationMembers.status, ACCEPTED)
      )
    )
    .orderBy(asc(organizations.name));
}

export interface OrganizationMemberItem {
  id: string;
  orgId: string;
  profileId: string;
  role: string;
  status: string;
  invitedBy: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * Invite a profile to an organization (owner/admin only).
 * The invite is created with status 'pending' and invitedBy set.
 * @param orgId - The organization ID
 * @param inviterProfileId - The inviting profile's ID
 * @param targetProfileId - The invited profile's ID
 * @returns Created membership row
 * @throws ConflictError if the profile already has a membership row
 */
export async function inviteMember(
  orgId: string,
  inviterProfileId: string,
  targetProfileId: string
): Promise<OrganizationMember> {
  await assertOrganizationExists(orgId);
  await assertManager(orgId, inviterProfileId);

  const [targetProfile] = await db
    .select({ id: profiles.id, deletedAt: profiles.deletedAt })
    .from(profiles)
    .where(eq(profiles.id, targetProfileId))
    .limit(1);

  if (!targetProfile || targetProfile.deletedAt) {
    throw new NotFoundError('Profile not found');
  }

  const existing = await getMembership(orgId, targetProfileId);

  // A rejected invite keeps its row (unique org+profile): reopen it instead of
  // treating the profile as a member forever.
  if (existing?.status === 'rejected') {
    const [reopened] = await db
      .update(organizationMembers)
      .set({ status: 'pending', role: 'member', invitedBy: inviterProfileId, requestedAt: new Date(), decidedAt: null })
      .where(eq(organizationMembers.id, existing.id))
      .returning();
    return reopened!;
  }

  if (existing) {
    throw new ConflictError('Profile is already a member of this organization');
  }

  const [member] = await db
    .insert(organizationMembers)
    .values({
      id: createId(),
      orgId,
      profileId: targetProfileId,
      role: 'member',
      status: 'pending',
      invitedBy: inviterProfileId,
      requestedAt: new Date(),
    })
    .returning();

  return member!;
}

/**
 * Decide a pending membership (the invited profile decides their own invite).
 * @param orgId - The organization ID
 * @param profileId - The deciding profile's ID
 * @param decision - 'accepted' or 'rejected'
 * @returns Updated membership row
 * @throws ForbiddenError if the profile has no pending invite
 */
export async function decideMembership(
  orgId: string,
  profileId: string,
  decision: 'accepted' | 'rejected'
): Promise<OrganizationMember> {
  await assertOrganizationExists(orgId);

  const member = await getMembership(orgId, profileId);

  if (!member || member.status !== 'pending') {
    throw new ForbiddenError('You have no pending invite to this organization');
  }

  const [updated] = await db
    .update(organizationMembers)
    .set({ status: decision, decidedAt: new Date() })
    .where(eq(organizationMembers.id, member.id))
    .returning();

  return updated!;
}

/**
 * Remove a member from an organization (owner/admin only).
 * The owner cannot be removed.
 * @param orgId - The organization ID
 * @param requesterProfileId - The requesting profile's ID
 * @param targetProfileId - The profile ID to remove
 * @throws ForbiddenError if requester is not a manager or target is the owner
 */
export async function removeMember(
  orgId: string,
  requesterProfileId: string,
  targetProfileId: string
): Promise<void> {
  const org = await assertOrganizationExists(orgId);
  await assertManager(orgId, requesterProfileId);

  const member = await getMembership(orgId, targetProfileId);

  if (!member) {
    throw new NotFoundError('Member not found');
  }

  if (member.profileId === org.ownerId) {
    throw new ForbiddenError('The organization owner cannot be removed');
  }

  await db
    .delete(organizationMembers)
    .where(eq(organizationMembers.id, member.id));
}

/**
 * Leave an organization. Any member can leave; the owner cannot (transfer
 * ownership first).
 * @param orgId - The organization ID
 * @param profileId - The leaving profile's ID
 * @throws NotFoundError if the profile has no membership
 * @throws ForbiddenError if the profile is the owner
 */
export async function leaveOrganization(orgId: string, profileId: string): Promise<void> {
  const org = await assertOrganizationExists(orgId);

  if (org.ownerId === profileId) {
    throw new ForbiddenError('The organization owner cannot leave');
  }

  const member = await getMembership(orgId, profileId);
  if (!member) {
    throw new NotFoundError('Member not found');
  }

  await db.delete(organizationMembers).where(eq(organizationMembers.id, member.id));
}

/**
 * List accepted members of an organization, ordered by role (owner first,
 * then admin, then member) and by username.
 * @param orgId - The organization ID
 * @param profileId - The requesting profile's ID (must be an accepted member)
 * @returns List of accepted members with profile info
 */
export async function listMembers(
  orgId: string,
  profileId: string
): Promise<OrganizationMemberItem[]> {
  await assertOrganizationExists(orgId);
  await assertAcceptedMember(orgId, profileId);

  return db
    .select({
      id: organizationMembers.id,
      orgId: organizationMembers.orgId,
      profileId: organizationMembers.profileId,
      role: organizationMembers.role,
      status: organizationMembers.status,
      invitedBy: organizationMembers.invitedBy,
      requestedAt: organizationMembers.requestedAt,
      decidedAt: organizationMembers.decidedAt,
      username: profiles.username,
      displayName: profiles.displayName,
      avatarUrl: profiles.avatarUrl,
    })
    .from(organizationMembers)
    .innerJoin(profiles, eq(organizationMembers.profileId, profiles.id))
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.status, ACCEPTED)
      )
    )
    .orderBy(
      sql`CASE ${organizationMembers.role} WHEN 'owner' THEN ${ROLE_RANK.owner} WHEN 'admin' THEN ${ROLE_RANK.admin} ELSE ${ROLE_RANK.member} END`,
      asc(profiles.username)
    );
}