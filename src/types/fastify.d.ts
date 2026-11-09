import { FastifyRequest, FastifyReply } from 'fastify';
import type { OAuth2Namespace } from '@fastify/oauth2';

declare module 'fastify' {
  interface FastifyInstance {
    /** Registered only when FEATURE_OAUTH is on; routes call requireFeature('oauth') first. */
    githubOAuth2: OAuth2Namespace;
    googleOAuth2: OAuth2Namespace;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
