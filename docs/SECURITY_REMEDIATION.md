# Security Remediation Plan

Generated from: docs/SECURITY.md (Session 21 audit)  
Last updated: March 29, 2026

> This document contains actionable remediation steps for every
> finding in the security audit. Each entry includes the problematic
> code, explanation, and corrected code snippet.
> Cross-reference with ROADMAP.md for release gates.

---

## Summary Table

| # | Severity | Title | File | Priority | Effort | Status (2026-11-09) |
|---|----------|-------|------|----------|--------|--------|
| 1 | CRITICAL | OAuth state not cryptographically validated | src/features/auth/oauth.routes.ts | Pre-MVP | Medium | Open (OAuth off by default) |
| 2 | HIGH | Missing rate limits - likes | src/features/likes/likes.routes.ts | Pre-MVP | Small | Fixed |
| 3 | HIGH | Missing rate limits - bookmarks | src/features/bookmarks/bookmarks.routes.ts | Pre-MVP | Small | Fixed |
| 4 | HIGH | Missing rate limits - follows | src/features/follows/follows.routes.ts | Pre-MVP | Small | Fixed |
| 5 | HIGH | Missing rate limits - exercise submit | src/features/tutorial-exercises/tutorial-exercises.routes.ts | Pre-MVP | Small | Fixed |
| 6 | HIGH | OAuth login flow missing state | src/features/auth/oauth.routes.ts | Pre-MVP | Medium | Open (OAuth off by default) |
| 7 | MEDIUM | URL validation too permissive | src/features/profiles/profiles.routes.ts, src/features/documents/documents.routes.ts | Beta | Small | Fixed |
| 8 | MEDIUM | userHash exposed in Authorship | src/features/documents/documents.service.ts | Beta | Small | Fixed |
| 9 | LOW | CORS configuration risk | src/config/env.ts, src/app.ts | Beta | Small | Fixed |

---

## Fix before Pre-MVP (CRITICAL + HIGH)

---

## [CRITICAL] OAuth State Parameter Not Cryptographically Validated

**Area**: Authentication / OAuth  
**File**: `src/features/auth/oauth.routes.ts`  
**Priority**: Fix before Pre-MVP  
**Effort**: Medium  
**Session**: Session 23

### Current code

```typescript
// src/features/auth/oauth.routes.ts — lines 84-93
app.get('/github/link/callback', {
  preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
  schema: { summary: 'Link GitHub account (callback)', tags: ['oauth'] },
}, async (request: FastifyRequest, reply: FastifyReply) => {
  const { code, state } = request.query as Record<string, string>;
  const userId = request.user.userId;

  if (!state?.startsWith('link:') || !code) {
    return reply.redirect(`${env.FRONTEND_URL}/settings/account?error=invalid_state`);
  }
  // ...
});
```

### Why this is a problem

The state validation only checks if the state string starts with "link:", which provides no security against CSRF attacks. An attacker can craft any state value starting with "link:" and bypass validation. This allows attackers to link their OAuth account to a victim's session.

### Recommended fix

Generate cryptographically random state tokens and validate them properly:

```typescript
// src/features/auth/oauth.routes.ts — ADD helper function at top of file
import { randomBytes } from 'node:crypto';

// In-memory store for OAuth states (use Redis in production)
const oauthStates = new Map<string, { userId?: string; expiresAt: Date; flow: 'login' | 'link' }>();

function generateOAuthState(flow: 'login' | 'link', userId?: string): string {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  oauthStates.set(token, { userId, expiresAt, flow });
  return token;
}

function validateOAuthState(token: string, expectedFlow: 'login' | 'link', expectedUserId?: string): boolean {
  const state = oauthStates.get(token);
  if (!state) return false;
  if (state.expiresAt < new Date()) {
    oauthStates.delete(token);
    return false;
  }
  if (state.flow !== expectedFlow) return false;
  if (expectedUserId && state.userId !== expectedUserId) return false;
  oauthStates.delete(token); // Single-use
  return true;
}
```

Then update the callback routes to use proper validation:

```typescript
// src/features/auth/oauth.routes.ts — lines 84-93 (updated)
app.get('/github/link/callback', {
  preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
  schema: { summary: 'Link GitHub account (callback)', tags: ['oauth'] },
}, async (request: FastifyRequest, reply: FastifyReply) => {
  const { code, state } = request.query as Record<string, string>;
  const userId = request.user.userId;

  if (!state || !validateOAuthState(state, 'link', userId)) {
    return reply.redirect(`${env.FRONTEND_URL}/settings/account?error=invalid_state`);
  }
  // ... rest of handler
});
```

### Notes

- Same fix needed for `/google/link/callback` (lines 155-164)
- Consider using Redis instead of in-memory Map for production to handle multiple instances
- Clean up expired states periodically (every 5 minutes)

---

## [HIGH] Missing Rate Limit - Likes

**Area**: Rate Limiting  
**File**: `src/features/likes/likes.routes.ts`  
**Priority**: Fix before Pre-MVP  
**Effort**: Small  
**Session**: Session 23

### Current code

```typescript
// src/features/likes/likes.routes.ts — lines 28-29
app.post('/documents/:id/like', {
  preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
  schema: {
    summary: 'Toggle like on a document',
    // No rateLimit config
```

### Why this is a problem

Like toggling has no explicit rate limit. While the global fallback (100/min) exists, it's insufficient for preventing like spam and engagement manipulation.

### Recommended fix

```typescript
// src/features/likes/likes.routes.ts — lines 28-34 (updated)
app.post('/documents/:id/like', {
  config: {
    rateLimit: {
      max: 30,
      timeWindow: '1 minute',
    },
  },
  preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
  schema: {
    summary: 'Toggle like on a document',
```

### Notes

- Same pattern needed for bookmark routes
- 30/min allows normal usage while preventing abuse

---

## [HIGH] Missing Rate Limit - Bookmarks

**Area**: Rate Limiting  
**File**: `src/features/bookmarks/bookmarks.routes.ts`  
**Priority**: Fix before Pre-MVP  
**Effort**: Small  
**Session**: Session 23

### Current code

```typescript
// src/features/bookmarks/bookmarks.routes.ts — lines 30-31
app.post('/documents/:id/bookmark', {
  preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
  // No rateLimit config
```

### Recommended fix

```typescript
// src/features/bookmarks/bookmarks.routes.ts — lines 30-36 (updated)
app.post('/documents/:id/bookmark', {
  config: {
    rateLimit: {
      max: 30,
      timeWindow: '1 minute',
    },
  },
  preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
```

---

## [HIGH] Missing Rate Limit - Follows

**Area**: Rate Limiting  
**File**: `src/features/follows/follows.routes.ts`  
**Priority**: Fix before Pre-MVP  
**Effort**: Small  
**Session**: Session 23

### Current code

```typescript
// src/features/follows/follows.routes.ts — lines 101-102
app.post('/profiles/:username/follow', {
  preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
  // No rateLimit config
```

### Recommended fix

```typescript
// src/features/follows/follows.routes.ts — lines 101-107 (updated)
app.post('/profiles/:username/follow', {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: '1 minute',
    },
  },
  preHandler: [(request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply)],
```

### Notes

- Also add to DELETE `/profiles/:username/follow` route (line 145)

---

## [HIGH] Missing Rate Limit - Exercise Submit

**Area**: Rate Limiting  
**File**: `src/features/tutorial-exercises/tutorial-exercises.routes.ts`  
**Priority**: Fix before Pre-MVP  
**Effort**: Small  
**Session**: Session 23

### Current code

```typescript
// src/features/tutorial-exercises/tutorial-exercises.routes.ts — lines 315-316
app.post('/exercises/:id/submit', {
  preHandler: async (request, reply) => {
    await app.authenticate(request, reply);
  },
  // No rateLimit config
```

### Recommended fix

```typescript
// src/features/tutorial-exercises/tutorial-exercises.routes.ts — lines 315-323 (updated)
app.post('/exercises/:id/submit', {
  config: {
    rateLimit: {
      max: 20,
      timeWindow: '1 minute',
    },
  },
  preHandler: async (request, reply) => {
    await app.authenticate(request, reply);
  },
```

### Notes

- Exercise submission includes code execution in sandbox, making rate limiting extra important

---

## [HIGH] OAuth Login Flow Missing State Parameter

**Area**: Authentication / OAuth  
**File**: `src/features/auth/oauth.routes.ts`  
**Priority**: Fix before Pre-MVP  
**Effort**: Medium  
**Session**: Session 23

### Current code

```typescript
// src/features/auth/oauth.routes.ts — lines 35-40
app.get('/github', {
  schema: { summary: 'Redirect to GitHub OAuth', tags: ['oauth'] },
}, async (_request: FastifyRequest, reply: FastifyReply) => {
  const redirectUrl = await githubOAuth.generateAuthorizationUri({ scope: ['user:email'] });
  return reply.redirect(redirectUrl);
});

// Lines 106-111 - Google same issue
app.get('/google', {
  schema: { summary: 'Redirect to Google OAuth', tags: ['oauth'] },
}, async (_request: FastifyRequest, reply: FastifyReply) => {
  const redirectUrl = await googleOAuth.generateAuthorizationUri({ scope: ['profile', 'email'] });
  return reply.redirect(redirectUrl);
});
```

### Why this is a problem

The login flows don't generate or pass any state parameter to the OAuth provider. This makes the login flow vulnerable to CSRF attacks where an attacker could trick a victim into logging into the attacker's account.

### Recommended fix

```typescript
// src/features/auth/oauth.routes.ts — lines 35-40 (updated)
app.get('/github', {
  schema: { summary: 'Redirect to GitHub OAuth', tags: ['oauth'] },
}, async (_request: FastifyRequest, reply: FastifyReply) => {
  const state = generateOAuthState('login');
  const redirectUrl = await githubOAuth.generateAuthorizationUri({ 
    scope: ['user:email'],
    state,
  });
  return reply.redirect(redirectUrl);
});

// src/features/auth/oauth.routes.ts — lines 106-111 (updated)
app.get('/google', {
  schema: { summary: 'Redirect to Google OAuth', tags: ['oauth'] },
}, async (_request: FastifyRequest, reply: FastifyReply) => {
  const state = generateOAuthState('login');
  const redirectUrl = await googleOAuth.generateAuthorizationUri({ 
    scope: ['profile', 'email'],
    state,
  });
  return reply.redirect(redirectUrl);
});
```

Then update callback handlers:

```typescript
// src/features/auth/oauth.routes.ts — lines 42-49 (updated callback)
app.get('/github/callback', {
  schema: { summary: 'GitHub OAuth callback', tags: ['oauth'] },
}, async (request: FastifyRequest, reply: FastifyReply) => {
  const { code, state } = request.query as { code?: string; state?: string };
  if (!code) {
    return reply.redirect(`${env.FRONTEND_URL}/login?error=missing_code`);
  }
  if (!state || !validateOAuthState(state, 'login')) {
    return reply.redirect(`${env.FRONTEND_URL}/login?error=invalid_state`);
  }
  // ... rest of handler
});
```

### Notes

- Requires the same `generateOAuthState` and `validateOAuthState` helper functions as the CRITICAL fix
- Same changes needed for Google OAuth routes

---

## Fix before Beta (MEDIUM)

---

## [MEDIUM] URL Validation Too Permissive

**Area**: Input Validation  
**File**: `src/features/profiles/profiles.routes.ts`, `src/features/documents/documents.routes.ts`  
**Priority**: Fix before Beta  
**Effort**: Small  
**Session**: Session 24

### Current code

```typescript
// src/features/profiles/profiles.routes.ts — line 213
avatarUrl: { type: ['string', 'null'] },

// src/features/documents/documents.routes.ts — lines 203, 279
coverImageUrl: { type: 'string', format: 'uri' },
```

### Why this is a problem

The URL validation accepts any URI scheme including `file://`, `ftp://`, `javascript:`, and `data:`. This could enable SSRF attacks if URLs are fetched server-side.

### Recommended fix

Update the Zod schemas to only allow HTTPS URLs:

```typescript
// src/features/profiles/profiles.routes.ts — ADD import at top
import { z } from 'zod';

// ADD helper function
function httpsUrlSchema() {
  return z.string()
    .url()
    .refine(
      (url) => {
        try {
          const parsed = new URL(url);
          return parsed.protocol === 'https:';
        } catch {
          return false;
        }
      },
      'URL must use HTTPS'
    );
}

// Update line 213 to use the helper
avatarUrl: httpsUrlSchema().nullable(),
```

```typescript
// src/features/documents/documents.routes.ts — lines 203, 279 (updated)
coverImageUrl: httpsUrlSchema(),
```

### Notes

- Add `httpsUrlSchema()` helper to a shared utils file for reuse
- This change affects both create and update document endpoints

---

## [MEDIUM] User Hash Exposed in Authorship Response

**Area**: Data Exposure  
**File**: `src/features/documents/documents.service.ts`  
**Priority**: Fix before Beta  
**Effort**: Small  
**Session**: Session 24

### Current code

```typescript
// src/features/documents/documents.service.ts — lines 59-67
export interface Authorship {
  authorName: string;
  username: string;
  userHash: string;
  documentHash: string;
  publicIdentifier: string;
  hmac: string;
  signedAt: string;
}
```

### Why this is a problem

The `userHash` field is exposed in the Authorship interface. While not the raw secret, this hash could enable user fingerprinting and activity correlation across anonymous sessions.

### Recommended fix

```typescript
// src/features/documents/documents.service.ts — lines 59-67 (updated)
export interface Authorship {
  authorName: string;
  username: string;
  documentHash: string;
  publicIdentifier: string;
  hmac: string;
  signedAt: string;
}
```

And remove userHash from the publish function:

```typescript
// Find where authorship is created (around line 359-367)
const authorship: Authorship = {
  authorName: profile.displayName ?? profile.username,
  username: profile.username,
  // REMOVE: userHash: signed.userHash,
  documentHash: signed.documentHash,
  publicIdentifier: signed.publicIdentifier,
  hmac: signed.signature,
  signedAt: new Date().toISOString(),
};
```

### Notes

- The `publicIdentifier` (PLT-xxxxxxxx.xxxxxxxx) already provides unique authorship identity
- This change only affects the response - internal logic can still use userHash for signing

---

## [LOW] CORS Configuration Risk in Production

**Area**: HTTP / Transport  
**File**: `src/config/env.ts`, `src/app.ts`  
**Priority**: Fix before Beta  
**Effort**: Small  
**Session**: Session 24

### Current code

```typescript
// src/config/env.ts — line 12
CORS_ORIGIN: z.string().default('*'),

// src/app.ts — line 62
await app.register(cors, { origin: env.CORS_ORIGIN, credentials: true });
```

### Why this is a problem

If CORS_ORIGIN is set to `*` in production with `credentials: true`, browsers will block requests. The current validation doesn't prevent this misconfiguration.

### Recommended fix

```typescript
// src/config/env.ts — lines 11-13 (updated)
NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
CORS_ORIGIN: z.string().refine(
  (origin) => {
    if (process.env.NODE_ENV === 'production' && origin === '*') {
      throw new Error('CORS_ORIGIN cannot be "*" in production');
    }
    return true;
  },
  { message: 'CORS_ORIGIN cannot be "*" in production' }
).default('*'),
```

### Notes

- The refine runs after the schema is parsed, so we need to check `process.env.NODE_ENV` directly
- Alternative: Add documentation in .env.example noting this restriction

---

## Verification Checklist

After implementing fixes, verify:

- [ ] OAuth flows redirect with state parameter and validate correctly
- [ ] Rate limits applied and tested on likes, bookmarks, follows, exercise submit
- [ ] URL validation rejects non-HTTPS URLs
- [ ] Authorship response no longer includes userHash
- [ ] CORS rejects `*` origin in production mode
- [ ] All existing tests still pass
