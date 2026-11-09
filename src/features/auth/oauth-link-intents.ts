import { randomBytes } from 'node:crypto';

export type OAuthProvider = 'github' | 'google';

export const LINK_INTENT_TTL_MS = 10 * 60 * 1000;

interface LinkIntent {
  userId: string;
  provider: OAuthProvider;
  expiresAt: number;
}

// shortcut: in-memory, so linking works on a single API instance (same as the
// chat ws-tickets); move to the database or Redis before running replicas.
const intents = new Map<string, LinkIntent>();

function prune(now: number): void {
  for (const [id, intent] of intents) {
    if (now > intent.expiresAt) intents.delete(id);
  }
}

/**
 * Record that a signed-in user wants to link a provider. The returned id is
 * only ever stored in an httpOnly cookie on that user's browser, so a leaked
 * provider callback cannot be replayed to link someone else's account.
 * @param userId - The authenticated user
 * @param provider - Provider to link
 * @returns Opaque intent id (32 random bytes, hex)
 */
export function createLinkIntent(userId: string, provider: OAuthProvider): string {
  const now = Date.now();
  prune(now);
  const id = randomBytes(32).toString('hex');
  intents.set(id, { userId, provider, expiresAt: now + LINK_INTENT_TTL_MS });
  return id;
}

/**
 * Check an intent without using it (start of the provider round-trip).
 * @returns The user id, or null when unknown, expired or for another provider
 */
export function peekLinkIntent(id: string | undefined, provider: OAuthProvider): string | null {
  if (!id) return null;
  const intent = intents.get(id);
  if (!intent || intent.provider !== provider || Date.now() > intent.expiresAt) return null;
  return intent.userId;
}

/**
 * Use an intent once (provider callback). Any lookup removes it.
 * @returns The user id, or null when unknown, expired or for another provider
 */
export function consumeLinkIntent(id: string | undefined, provider: OAuthProvider): string | null {
  const userId = peekLinkIntent(id, provider);
  if (id) intents.delete(id);
  return userId;
}
