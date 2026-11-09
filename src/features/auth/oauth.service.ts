import { eq } from 'drizzle-orm';
import { db } from '../../db/index';
import { users } from './auth.schema';
import { createId } from '@paralleldrive/cuid2';
import { NotFoundError, ConflictError, ValidationError } from '../../utils/errors';

export interface OAuthUser {
  id: string;
  email: string;
  name: string;
  login?: string;
}

export interface OAuthLoginResult {
  userId: string;
  onboardingComplete: boolean;
  isNew: boolean;
}

/**
 * Fetch user data from GitHub API.
 * @param accessToken - GitHub access token
 * @returns GitHub user data; email is empty unless it is the verified primary
 */
export async function fetchGitHubUser(accessToken: string): Promise<OAuthUser> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch GitHub user');
  }

  const data = await response.json() as {
    id: number;
    name: string | null;
    login: string;
  };

  // Only a verified primary address: an unverified one could belong to
  // someone else, and handleOAuthLogin creates accounts by email.
  let email: string | undefined;
  const emailsResponse = await fetch('https://api.github.com/user/emails', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (emailsResponse.ok) {
    const emails = await emailsResponse.json() as Array<{ primary: boolean; verified: boolean; email: string }>;
    email = emails.find((e) => e.primary && e.verified)?.email;
  }

  return {
    id: String(data.id),
    email: email ?? '',
    name: data.name || data.login || '',
    login: data.login,
  };
}

/**
 * Fetch user data from Google API.
 * @param accessToken - Google access token
 * @returns Google user data; email is empty unless Google marks it verified
 */
export async function fetchGoogleUser(accessToken: string): Promise<OAuthUser> {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch Google user');
  }

  const data = await response.json() as {
    id: string;
    email: string | null;
    verified_email?: boolean;
    name: string | null;
  };

  return {
    id: data.id,
    email: data.verified_email ? data.email || '' : '',
    name: data.name || '',
  };
}

/**
 * Handle OAuth login or registration.
 * @param provider - OAuth provider ('github' or 'google')
 * @param providerUserId - The provider's user ID
 * @param email - User's email from provider
 * @returns Login result with user ID and onboarding status
 */
export async function handleOAuthLogin(
  provider: 'github' | 'google',
  providerUserId: string,
  email: string
): Promise<OAuthLoginResult> {
  const providerIdField = provider === 'github' ? users.githubId : users.googleId;

  const existingByProvider = await db
    .select()
    .from(users)
    .where(eq(providerIdField, providerUserId))
    .limit(1);

  if (existingByProvider.length > 0) {
    const user = existingByProvider[0]!;
    if (!user.onboardingComplete) {
      return { userId: user.id, onboardingComplete: false, isNew: false };
    }
    return { userId: user.id, onboardingComplete: true, isNew: false };
  }

  const existingByEmail = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  if (existingByEmail.length > 0) {
    throw new ConflictError(
      'An account with this email already exists. Please log in and link your GitHub/Google account instead.'
    );
  }

  const userId = createId();

  await db.insert(users).values({
    id: userId,
    email: email.toLowerCase(),
    username: `${provider}_${providerUserId}`,
    [provider === 'github' ? 'githubId' : 'googleId']: providerUserId,
    onboardingComplete: false,
    passwordHash: null,
    salt: null,
  });

  return { userId, onboardingComplete: false, isNew: true };
}

/**
 * Link an OAuth provider to an existing user account.
 * @param userId - The user's ID
 * @param provider - OAuth provider ('github' or 'google')
 * @param providerUserId - The provider's user ID
 */
export async function handleOAuthLink(
  userId: string,
  provider: 'github' | 'google',
  providerUserId: string
): Promise<void> {
  const providerIdField = provider === 'github' ? users.githubId : users.googleId;

  const existing = await db
    .select()
    .from(users)
    .where(eq(providerIdField, providerUserId))
    .limit(1);

  if (existing.length > 0 && existing[0]!.id !== userId) {
    throw new ConflictError(
      `This ${provider === 'github' ? 'GitHub' : 'Google'} account is already linked to another user`
    );
  }

  const currentUser = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (currentUser.length === 0) {
    throw new NotFoundError('User not found');
  }

  await db
    .update(users)
    .set({
      [provider === 'github' ? 'githubId' : 'googleId']: providerUserId,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

/**
 * Unlink an OAuth provider from a user account.
 * @param userId - The user's ID
 * @param provider - OAuth provider ('github' or 'google')
 */
export async function unlinkProvider(
  userId: string,
  provider: 'github' | 'google'
): Promise<void> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  const hasPassword = user.passwordHash !== null;
  const hasGitHub = user.githubId !== null;
  const hasGoogle = user.googleId !== null;

  const methodsCount = [hasPassword, hasGitHub, hasGoogle].filter(Boolean).length;

  if (methodsCount <= 1) {
    throw new ValidationError(
      'Cannot unlink your only login method. Add a password or another provider first.'
    );
  }

  const updateField = provider === 'github' ? 'githubId' : 'googleId';

  await db
    .update(users)
    .set({
      [updateField]: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}
