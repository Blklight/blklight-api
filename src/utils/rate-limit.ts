import type { FastifyRequest } from 'fastify';

/**
 * Route-level rate limit keyed by the authenticated user.
 * Runs on preHandler so it sees request.user (route preHandlers such as
 * app.authenticate run first); falls back to the IP for anonymous requests.
 * @param max - Requests allowed per window
 * @param timeWindow - Window length (default 1 minute)
 * @returns Value for a route's config.rateLimit
 */
export function perUserRateLimit(max: number, timeWindow = '1 minute') {
  return {
    max,
    timeWindow,
    hook: 'preHandler' as const,
    keyGenerator: (request: FastifyRequest) => request.user?.userId ?? request.ip,
  };
}
