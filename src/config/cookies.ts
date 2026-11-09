import { env } from './env';
import { parseDurationMs } from '../utils/duration';

/**
 * Name of the cookie carrying the session refresh token.
 * Single source of truth: the browser sends it back on /auth/refresh and
 * /auth/logout, and the client never sees the value because the cookie is
 * httpOnly. Only the access token is ever exposed in a response body.
 */
export const REFRESH_COOKIE_NAME = 'refreshToken';

type RefreshCookieOptions = {
  httpOnly: true;
  path: '/';
  sameSite: 'strict' | 'lax' | 'none';
  secure: boolean;
  maxAge?: number;
};

/**
 * Build the options for setting or clearing the refresh cookie.
 * Every write path (login, register, OAuth callback, onboarding) and every
 * clear path must go through this function so set and clear attributes always
 * match: browsers only drop a cookie when the clearing Set-Cookie repeats the
 * original name, path and domain.
 *
 * No domain is set on purpose, keeping the cookie host-only for the API.
 *
 * `secure` is forced on when SameSite=None because browsers reject a
 * SameSite=None cookie that is not Secure.
 * @param maxAgeSeconds - Cookie lifetime in seconds; omit when clearing
 * @returns Options for reply.setCookie / reply.clearCookie
 */
export function buildRefreshCookieOptions(maxAgeSeconds?: number): RefreshCookieOptions {
  const sameSite = env.COOKIE_SAMESITE;
  const secure = env.NODE_ENV === 'production' || sameSite === 'none';

  return {
    httpOnly: true,
    path: '/',
    sameSite,
    secure,
    ...(maxAgeSeconds === undefined ? {} : { maxAge: Math.floor(maxAgeSeconds) }),
  };
}

/**
 * Options for clearing the refresh cookie.
 * Max-Age is intentionally omitted: @fastify/cookie turns a clearCookie call
 * into an expired cookie (Max-Age=0 / past Expires) on its own.
 * @returns Options for reply.clearCookie, matching the set attributes
 */
export function buildRefreshCookieClearOptions(): RefreshCookieOptions {
  return buildRefreshCookieOptions();
}

/**
 * Resolve the refresh session lifetime in whole seconds.
 *
 * Single source of truth for the two places that must never disagree: the
 * cookie Max-Age (client side) and sessions.expires_at (server side). A
 * divergence would let the browser keep a cookie the server already considers
 * expired, or drop one that is still valid.
 *
 * Returned value is floored, never rounded, so the server-side expiry is never
 * later than what the browser believes it has.
 * @param rememberMe - Whether this session uses the longer "remember me" TTL
 * @returns Lifetime in integer seconds
 */
export function getRefreshTtlSeconds(rememberMe: boolean | undefined): number {
  const ttl = rememberMe ? env.JWT_REFRESH_REMEMBER_TTL : env.JWT_REFRESH_EXPIRES_IN;
  return Math.floor(parseDurationMs(ttl) / 1000);
}

/**
 * Refresh cookie options for a session that is being written.
 * Without "remember me" the cookie carries no Max-Age, so the browser drops it
 * when it closes; the server-side session still expires after
 * JWT_REFRESH_EXPIRES_IN. With "remember me" it lives for JWT_REFRESH_REMEMBER_TTL.
 * @param rememberMe - Whether the session uses the longer "remember me" TTL
 * @returns Options for reply.setCookie
 */
export function buildSessionRefreshCookieOptions(rememberMe: boolean | undefined): RefreshCookieOptions {
  return buildRefreshCookieOptions(rememberMe ? getRefreshTtlSeconds(true) : undefined);
}
