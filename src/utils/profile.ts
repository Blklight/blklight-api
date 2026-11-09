import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { profiles } from '../features/profiles/profiles.schema';
import { NotFoundError } from './errors';

const MAX_CACHED_PROFILES = 10_000;

// userId -> profileId is 1:1 and never changes once the profile exists (account
// deletion is a soft delete that keeps the row), so a positive result can be
// cached for the life of the process. Misses are not cached: a user who has not
// finished onboarding gets a profile later.
const profileIdByUserId = new Map<string, string>();

/**
 * Resolve the profile ID for a given user ID.
 * @param userId - The user's ID (from JWT payload)
 * @returns The corresponding profile ID
 * @throws NotFoundError if no profile exists for this user
 */
export async function resolveProfileIdFromUserId(userId: string): Promise<string> {
  const cached = profileIdByUserId.get(userId);
  if (cached) return cached;

  const [profile] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  if (!profile) {
    throw new NotFoundError('Profile not found');
  }

  if (profileIdByUserId.size >= MAX_CACHED_PROFILES) {
    // Map keeps insertion order: drop the oldest entry.
    const oldest = profileIdByUserId.keys().next().value;
    if (oldest !== undefined) profileIdByUserId.delete(oldest);
  }
  profileIdByUserId.set(userId, profile.id);

  return profile.id;
}
