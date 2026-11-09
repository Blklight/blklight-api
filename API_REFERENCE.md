# API Reference — blklight-fastify-api

Base URL: `http://localhost:3000`

> See [docs/ROADMAP.md](../docs/ROADMAP.md) for the recommended order to enable and test features per release phase.

## TypeScript Types

All API types are available in [types/api.types.ts](../types/api.types.ts).
Copy this file to your frontend project for full type safety.

> **Note on Authentication:** When copying types, import `ApiResponse<T>` and handle `error` field for proper error handling.

---

## Feature Flags

Some features can be disabled via environment variables. Disabled features return 503 with code `FEATURE_DISABLED`.

| Flag | Default | Requires |
|------|---------|----------|
| FEATURE_EMAIL | false | RESEND_API_KEY, EMAIL_FROM |
| FEATURE_OAUTH | false | OAuth client credentials |
| FEATURE_EMAIL_QUEUE | false | FEATURE_EMAIL=true |
| FEATURE_CODE_SANDBOX | true | none |

Affected routes per flag:

- **FEATURE_EMAIL**: verify-email, resend-verification, forgot-password, reset-password
- **FEATURE_OAUTH**: all /auth/github and /auth/google routes
- **FEATURE_CODE_SANDBOX**: POST /exercises/:id/submit

---

### GET /api/v1/documents

Get a paginated feed of published documents.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| cursor | string | - | Opaque cursor for pagination (omit for first page) |
| limit | integer | 20 | Results per page (max 50) |
| type | string | - | Filter by document type (article, tutorial, contract, project, page) |
| author | string | - | Filter by author's username |
| q | string | - | Search in title and abstract (max 100 chars) |
| sort | string | recent | Sort order: "recent" or "popular" |
| category | string | - | Filter by category slug |
| tag | string | - | Filter by tag slug |

**Pagination:**

To get the first page, omit the `cursor` parameter. The response includes a `nextCursor` field. To get the next page, pass this cursor value in the `cursor` query parameter. When `nextCursor` is `null`, there are no more results.

**Example Request:**
```
GET /api/v1/documents?limit=10&type=article&sort=recent
```

**Example Response (200):**
```json
{
  "data": {
    "items": [
      {
        "id": "doc123abc...",
        "title": "Getting Started with TypeScript",
        "abstract": "A comprehensive guide to TypeScript basics",
        "coverImageUrl": "https://example.com/cover.jpg",
        "slug": "getting-started-with-typescript",
        "publishedAt": "2024-02-15T10:00:00.000Z",
        "typeName": "article",
        "author": {
          "username": "johndoe",
          "displayName": "John Doe",
          "avatarUrl": "https://example.com/avatar.jpg"
        },
        "authorship": {
          "publicIdentifier": "PLT-xxxxxxxx.xxxxxxxx"
        },
        "likesCount": 42
      }
    ],
    "nextCursor": "eyJwdWJsaXNoZWRBdCI6IjIwMjQtMDItMTVUMTA6MDA6MDAuMDAwWiIsImlkIjoiZG9jMTIzYWJjLi4uIn0=",
    "total": 42
  },
  "error": null,
  "message": "Feed retrieved"
}
```

**Note:** The `cursor` value is base64-encoded JSON. Pass it as-is to the next request. Tutorial exercises are not included in feed items — only in full document reads.

**Error Codes:** `VALIDATION_ERROR`

---

### GET /api/v1/documents/:username/:slug

Get the full content of a published document.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| username | string | Author's username |
| slug | string | Document's URL-friendly slug |

**Example Response (200):**
```json
{
  "data": {
    "id": "doc123abc...",
    "title": "Understanding Async/Await in JavaScript",
    "abstract": "Learn how to work with asynchronous code",
    "content": {
      "type": "doc",
      "content": [...]
    },
    "coverImageUrl": "https://example.com/cover.jpg",
    "slug": "understanding-async-await",
    "publishedAt": "2024-02-15T10:00:00.000Z",
    "typeName": "tutorial",
    "author": {
      "username": "johndoe",
      "displayName": "John Doe",
      "avatarUrl": "https://example.com/avatar.jpg"
    },
    "style": {
      "typography": "sans",
      "paperStyle": null,
      "paperTexture": null,
      "coverSettings": null,
      "documentHeader": null,
      "documentFooter": null,
      "documentSignature": null
    },
    "authorship": {
      "authorName": "John Doe",
      "username": "johndoe",
      "userHash": "abc123...",
      "documentHash": "def456...",
      "publicIdentifier": "PLT-xxxxxxxx.xxxxxxxx",
      "hmac": "hmac789...",
      "signedAt": "2024-02-15T10:00:00.000Z"
    },
    "exercises": [
      {
        "id": "exr123abc...",
        "documentId": "doc123...",
        "type": "code",
        "data": {
          "prompt": "Write a function that returns 'Hello, World!'",
          "language": "javascript",
          "initialCode": "// Start here\n"
        },
        "createdAt": "2024-02-15T10:00:00.000Z",
        "updatedAt": "2024-02-15T10:00:00.000Z"
      }
    ]
  },
  "error": null,
  "message": "Document retrieved"
}
```

**Note:** The `exercises` array is only included for documents of type "tutorial". For other types, this field is omitted.

**Error Codes:** `NOT_FOUND`

---

### GET /api/v1/profiles/:username

Get a public profile by username.

**Auth Required:** No

**Example Response (200):**
```json
{
  "data": {
    "username": "johndoe",
    "displayName": "John Doe",
    "bio": "Software developer",
    "avatarUrl": "https://example.com/avatar.jpg",
    "socialLinks": {
      "twitter": "https://twitter.com/johndoe",
      "github": "https://github.com/johndoe"
    },
    "createdAt": "2024-01-15T10:30:00.000Z"
  },
  "error": null,
  "message": "Profile retrieved"
}
```

**Error Codes:** `NOT_FOUND`

---

### GET /api/v1/profiles/:username/documents

Get a paginated list of a specific author's published documents.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| username | string | Author's username |

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| cursor | string | - | Pagination cursor |
| limit | integer | 20 | Results per page (max 50) |
| type | string | - | Filter by document type |

**Example Response (200):**
```json
{
  "data": {
    "items": [
      {
        "id": "doc123abc...",
        "title": "Getting Started with TypeScript",
        "abstract": "A comprehensive guide to TypeScript basics",
        "coverImageUrl": "https://example.com/cover.jpg",
        "slug": "getting-started-with-typescript",
        "publishedAt": "2024-02-15T10:00:00.000Z",
        "typeName": "article",
        "author": {
          "username": "johndoe",
          "displayName": "John Doe",
          "avatarUrl": "https://example.com/avatar.jpg"
        },
        "authorship": {
          "publicIdentifier": "PLT-xxxxxxxx.xxxxxxxx"
        },
        "likesCount": 42
      }
    ],
    "nextCursor": null,
    "total": 5
  },
  "error": null,
  "message": "Author documents retrieved"
}
```

**Error Codes:** `NOT_FOUND`, `VALIDATION_ERROR`

---

## Likes

### POST /api/v1/documents/:id/like

Toggle like status on a document. If already liked, this will unlike the document.

**Auth Required:** Yes

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Document ID |

**Example Response (200):**
```json
{
  "data": {
    "liked": true,
    "likesCount": 42
  },
  "error": null,
  "message": "Document liked"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

### GET /api/v1/documents/:id/likes

Get the likes count for a document. If authenticated, also indicates whether the current user has liked it.

**Auth Required:** No (optional)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Document ID |

**Example Response (200):**
```json
{
  "data": {
    "likesCount": 42,
    "likedByMe": true
  },
  "error": null,
  "message": "OK"
}
```

**Note:** `likedByMe` is `null` when not authenticated (not `false`).

**Error Codes:** `NOT_FOUND`

---

## Bookmarks

### POST /api/v1/documents/:id/bookmark

Toggle bookmark status on a document. If already bookmarked, this will remove the bookmark.

**Auth Required:** Yes

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Document ID |

**Example Response (200):**
```json
{
  "data": {
    "bookmarked": true
  },
  "error": null,
  "message": "Bookmark added"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

### GET /api/v1/bookmarks/me

Get the authenticated user's bookmarked documents.

**Auth Required:** Yes

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| cursor | string | - | Pagination cursor |
| limit | integer | 20 | Results per page (max 50) |

**Example Response (200):**
```json
{
  "data": {
    "items": [
      {
        "id": "doc123abc...",
        "title": "Getting Started with TypeScript",
        "abstract": "A comprehensive guide to TypeScript basics",
        "coverImageUrl": "https://example.com/cover.jpg",
        "slug": "getting-started-with-typescript",
        "publishedAt": "2024-02-15T10:00:00.000Z",
        "typeName": "article",
        "author": {
          "username": "johndoe",
          "displayName": "John Doe",
          "avatarUrl": "https://example.com/avatar.jpg"
        },
        "authorship": {
          "publicIdentifier": "PLT-xxxxxxxx.xxxxxxxx"
        },
        "likesCount": 42,
        "likesCount": 42
      }
    ],
    "nextCursor": null,
    "total": 3
  },
  "error": null,
  "message": "Bookmarks retrieved"
}
```

**Note:** Bookmarks are private — only the authenticated user can see their own bookmarks.

**Error Codes:** `UNAUTHORIZED`, `VALIDATION_ERROR`

---

## Categories

> Categories are pre-seeded in English via `npm run db:seed`. Use Drizzle Studio (`npm run db:studio`) to add more.

### GET /api/v1/categories

Get all categories in a hierarchical tree structure.

**Auth Required:** No

**Example Response (200):**
```json
{
  "data": [
    {
      "id": "cat123...",
      "name": "Technology",
      "slug": "technology",
      "description": "Articles about tech",
      "parentId": null,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "children": [
        {
          "id": "cat456...",
          "name": "Programming",
          "slug": "programming",
          "description": "Programming guides",
          "parentId": "cat123...",
          "createdAt": "2024-01-02T00:00:00.000Z",
          "children": []
        }
      ],
      "documentCount": 10
    }
  ],
  "error": null,
  "message": "Categories retrieved"
}
```

---

### GET /api/v1/categories/:slug

Get a single category by slug.

**Auth Required:** No

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| slug | string | Category slug |

**Example Response (200):**
```json
{
  "data": {
    "id": "cat123...",
    "name": "Technology",
    "slug": "technology",
    "description": "Articles about tech",
    "parentId": null,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "children": [],
    "documentCount": 10
  },
  "error": null,
  "message": "Category retrieved"
}
```

**Error Codes:** `NOT_FOUND`

---

### POST /api/v1/categories

Create a new category.

**Auth Required:** Yes (admin only)

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Category name (max 50) |
| description | string | No | Category description (max 200) |
| parentId | string | No | Parent category ID for hierarchy |

**Example Response (201):**
```json
{
  "data": {
    "id": "cat789...",
    "name": "Science",
    "slug": "science",
    "description": null,
    "parentId": null,
    "createdAt": "2024-01-03T00:00:00.000Z"
  },
  "error": null,
  "message": "Category created"
}
```

**Error Codes:** `UNAUTHORIZED`, `FORBIDDEN`, `VALIDATION_ERROR`, `NOT_FOUND`

---

### PATCH /api/v1/categories/:id

Update a category.

**Auth Required:** Yes (admin only)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Category ID |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | No | New category name (max 50) |
| description | string | No | New description (max 200) |
| parentId | string | No | New parent ID (set to null for root) |

**Example Response (200):**
```json
{
  "data": {
    "id": "cat789...",
    "name": "Natural Science",
    "slug": "natural-science",
    "description": "Biology, chemistry, physics",
    "parentId": null,
    "createdAt": "2024-01-03T00:00:00.000Z"
  },
  "error": null,
  "message": "Category updated"
}
```

**Error Codes:** `UNAUTHORIZED`, `FORBIDDEN`, `VALIDATION_ERROR`, `NOT_FOUND`

---

### DELETE /api/v1/categories/:id

Delete a category. Orphaned children are reparented to root.

**Auth Required:** Yes (admin only)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Category ID |

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Category deleted"
}
```

**Error Codes:** `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`

---

## Tags

> Tags are pre-seeded in English via `npm run db:seed`. Tags are normalized (trim + lowercase).

### GET /api/v1/tags/popular

Get popular tags sorted by document count.

**Auth Required:** No

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 20 | Max tags to return (max 50) |

**Example Response (200):**
```json
{
  "data": [
    {
      "id": "tag123...",
      "name": "typescript",
      "slug": "typescript",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "documentCount": 25
    },
    {
      "id": "tag456...",
      "name": "javascript",
      "slug": "javascript",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "documentCount": 18
    }
  ],
  "error": null,
  "message": "Tags retrieved"
}
```

**Error Codes:** `VALIDATION_ERROR`

---

## Authentication

Most endpoints require authentication via Bearer token. Pass the JWT access token in the `Authorization` header:

```
Authorization: Bearer <access_token>
```

Auth endpoints also use httpOnly cookies for refresh tokens. The refresh token is automatically set when you register or login.

## Response Format

### Success
```json
{
  "data": <payload>,
  "error": null,
  "message": "Operation description"
}
```

### Error
```json
{
  "data": null,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  },
  "message": "Human-readable summary"
}
```

### Validation Error
```json
{
  "data": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "fields": {
      "fieldName": "Validation error message"
    }
  },
  "message": "Validation failed"
}
```

---

## Auth

### POST /api/v1/auth/register

Register a new user account.

**Auth Required:** No

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| email | string | Yes | Valid email address |
| username | string | Yes | 3-30 chars, alphanumeric + underscores |
| password | string | Yes | Min 8 chars |

**Example Request:**
```json
{
  "email": "user@example.com",
  "username": "johndoe",
  "password": "securepassword123"
}
```

**Example Response (201):**
```json
{
  "data": {
    "userId": "cls123abc...",
    "email": "user@example.com",
    "username": "johndoe"
  },
  "error": null,
  "message": "User registered"
}
```

**Error Codes:** `VALIDATION_ERROR`, `CONFLICT`

---

### POST /api/v1/auth/login

Login with email or username.

**Auth Required:** No

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| identifier | string | Yes | Email address or username |
| password | string | Yes | Account password |

**Example Request:**
```json
{
  "identifier": "user@example.com",
  "password": "securepassword123"
}
```

**Example Request (with username):**
```json
{
  "identifier": "johndoe",
  "password": "securepassword123"
}
```

**Example Response (200):**
```json
{
  "data": {
    "userId": "cls123abc...",
    "email": "user@example.com",
    "username": "johndoe"
  },
  "error": null,
  "message": "Login successful"
}
```

A `refresh_token` cookie is set automatically (httpOnly, secure in production).

**Error Codes:** `VALIDATION_ERROR`, `UNAUTHORIZED`

---

### POST /api/v1/auth/refresh

Refresh the access token using the refresh token cookie.

**Auth Required:** No (cookie only)

**Example Response (200):**
```json
{
  "data": {
    "userId": "cls123abc...",
    "email": "user@example.com",
    "username": "johndoe"
  },
  "error": null,
  "message": "Token refreshed"
}
```

**Error Codes:** `UNAUTHORIZED`

---

### POST /api/v1/auth/logout

Invalidate the current session and clear the refresh token cookie.

**Auth Required:** Yes

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Logged out"
}
```

**Error Codes:** `UNAUTHORIZED`

---

## OAuth

### GET /api/v1/auth/github · GET /api/v1/auth/google

Redirect to the provider's authorization page. The plugin stores a random `state` and a PKCE verifier in httpOnly cookies; the provider returns to `/api/v1/auth/{provider}/callback`. Clears any pending link intent.

**Auth Required:** No

---

### POST /api/v1/auth/{provider}/link

Start linking `github` or `google` to the signed-in account. Call it with `fetch` (Bearer token, `credentials: 'include'`): it stores a single-use link intent (10 min) in the httpOnly cookie `oauthLinkIntent`, bound to this browser, and returns the URL to navigate to.

**Auth Required:** Yes

**Response:** `{ data: { url: "{OAUTH_REDIRECT_BASE_URL}/api/v1/auth/{provider}/link/start" } }`

---

### GET /api/v1/auth/{provider}/link/start

Browser navigation after `POST /link`. Redirects to the provider when the `oauthLinkIntent` cookie holds a live intent; otherwise to `FRONTEND_URL/settings/account?error=link_expired`.

**Auth Required:** No (the intent cookie identifies the user)

---

### GET /api/v1/auth/{provider}/callback

Single callback for login and linking. Validates the `state` cookie and exchanges the code (PKCE). Only a provider-verified email is accepted.

- **With `oauthLinkIntent` cookie (linking):** consumes the intent and links the provider to that user.
  - Success: `FRONTEND_URL/settings/account?linked={provider}`
  - Errors: `FRONTEND_URL/settings/account?error={oauth_failed|link_expired|already_linked|{provider}_verified_email_required}`
- **Without it (login/register):** finds or creates the user and sets the refresh cookie (session); no token goes in the URL. The front gets an access token from `POST /api/v1/auth/refresh`.
  - Onboarding pending: `FRONTEND_URL/onboarding`
  - Existing user: `FRONTEND_URL/dashboard`
  - Errors: `FRONTEND_URL/login?error={oauth_failed|account_exists|{provider}_verified_email_required}`

**Auth Required:** No

---

### POST /api/v1/auth/onboarding

Complete OAuth user onboarding by choosing a username. Creates profile, signature, and workspace.

**Auth Required:** Yes (token from OAuth onboarding redirect)

**Request Body:**
```json
{
  "username": "johndoe"
}
```

**Validation:** 3-30 chars, letters/numbers/underscores only

**Example Response (201):**
```json
{
  "data": {
    "accessToken": "eyJ..."
  },
  "error": null,
  "message": "Onboarding complete"
}
```

**Error Codes:** `VALIDATION_ERROR`, `CONFLICT` (username taken), `UNAUTHORIZED`

---

### DELETE /api/v1/auth/account/unlink/:provider

Unlink an OAuth provider from your account.

**Auth Required:** Yes

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| provider | string | `github` or `google` |

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Provider unlinked successfully"
}
```

**Error Codes:** `VALIDATION_ERROR` (last login method), `UNAUTHORIZED`

---

## Profiles

### GET /api/v1/profiles/:username

Get a public profile by username.

**Auth Required:** No

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| username | string | The username to look up |

**Example Response (200):**
```json
{
  "data": {
    "id": "prf123abc...",
    "username": "johndoe",
    "displayName": "John Doe",
    "bio": "Software developer",
    "avatarUrl": "https://example.com/avatar.jpg",
    "socialLinks": {
      "twitter": "https://twitter.com/johndoe",
      "github": "https://github.com/johndoe"
    },
    "createdAt": "2024-01-15T10:30:00.000Z"
  },
  "error": null,
  "message": "Profile retrieved"
}
```

**Error Codes:** `NOT_FOUND`

---

### GET /api/v1/profiles/me

Get the authenticated user's own profile.

**Auth Required:** Yes

**Example Response (200):**
```json
{
  "data": {
    "id": "prf123abc...",
    "userId": "usr123abc...",
    "username": "johndoe",
    "displayName": "John Doe",
    "bio": "Software developer",
    "avatarUrl": "https://example.com/avatar.jpg",
    "socialLinks": {
      "twitter": "https://twitter.com/johndoe"
    },
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-02-20T14:45:00.000Z"
  },
  "error": null,
  "message": "Profile retrieved"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

### PATCH /api/v1/profiles/me

Update the authenticated user's own profile.

**Auth Required:** Yes

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| displayName | string | No | Max 100 chars |
| bio | string | No | Max 500 chars |
| avatarUrl | string | No | Valid URL |
| socialLinks | object | No | Social media links |

**Example Request:**
```json
{
  "displayName": "John D.",
  "bio": "Full-stack developer and open source enthusiast",
  "socialLinks": {
    "twitter": "https://twitter.com/johnd",
    "github": "https://github.com/johnd"
  }
}
```

**Example Response (200):**
```json
{
  "data": {
    "id": "prf123abc...",
    "username": "johndoe",
    "displayName": "John D.",
    "bio": "Full-stack developer and open source enthusiast",
    "avatarUrl": null,
    "socialLinks": {
      "twitter": "https://twitter.com/johnd",
      "github": "https://github.com/johnd"
    },
    "updatedAt": "2024-03-01T09:00:00.000Z"
  },
  "error": null,
  "message": "Profile updated"
}
```

**Error Codes:** `UNAUTHORIZED`, `VALIDATION_ERROR`, `CONFLICT`

---

### DELETE /api/v1/profiles/me

Delete the authenticated user's account (soft delete).

**Auth Required:** Yes

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Account deleted"
}
```

**Error Codes:** `UNAUTHORIZED`

---

## Documents

### GET /api/v1/documents/me

List the authenticated user's documents.

**Auth Required:** Yes

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 20 | Max 1-100 |
| offset | integer | 0 | Pagination offset |

**Example Response (200):**
```json
{
  "data": [
    {
      "id": "doc123abc...",
      "title": "Getting Started with TypeScript",
      "abstract": "A comprehensive guide to TypeScript basics",
      "status": "published",
      "typeName": "article",
      "slug": "getting-started-with-typescript",
      "coverImageUrl": "https://example.com/cover.jpg",
      "authorship": {
        "authorName": "John Doe",
        "username": "johndoe",
        "userHash": "abc123...",
        "documentHash": "def456...",
        "publicIdentifier": "PLT-xxxxxxxx.xxxxxxxx",
        "hmac": "hmac123...",
        "signedAt": "2024-02-15T10:00:00.000Z"
      },
      "publishedAt": "2024-02-15T10:00:00.000Z",
      "updatedAt": "2024-02-15T10:00:00.000Z",
      "createdAt": "2024-02-10T08:00:00.000Z"
    }
  ],
  "error": null,
  "message": "Documents retrieved"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

### POST /api/v1/documents

Create a new document.

**Auth Required:** Yes

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | Yes | 1-200 chars |
| type | string | Yes | Document type (article, tutorial, contract, project, page) |
| abstract | string | No | Max 500 chars |
| content | object | No | TipTap JSON content |
| coverImageUrl | string | No | Valid URL |
| slug | string | No | Custom slug (lowercase alphanumeric with hyphens) |
| categoryId | string | No | Category ID (required on publish) |
| tags | string[] | No | Tag names (max 5) |

**Example Request:**
```json
{
  "title": "Understanding Async/Await in JavaScript",
  "type": "tutorial",
  "abstract": "Learn how to work with asynchronous code",
  "slug": "understanding-async-await"
}
```

**Example Response (201):**
```json
{
  "data": {
    "id": "doc123abc...",
    "authorId": "prf123abc...",
    "typeId": "tut123...",
    "typeName": "tutorial",
    "status": "draft",
    "title": "Understanding Async/Await in JavaScript",
    "abstract": "Learn how to work with asynchronous code",
    "content": null,
    "coverImageUrl": null,
    "slug": "understanding-async-await",
    "authorship": null,
    "publishedAt": null,
    "createdAt": "2024-03-01T10:00:00.000Z",
    "updatedAt": "2024-03-01T10:00:00.000Z",
    "style": {
      "typography": "sans",
      "paperStyle": null,
      "paperTexture": null,
      "coverSettings": null,
      "documentHeader": null,
      "documentFooter": null,
      "documentSignature": null
    }
  },
  "error": null,
  "message": "Document created"
}
```

**Error Codes:** `UNAUTHORIZED`, `VALIDATION_ERROR`

---

### PATCH /api/v1/documents/:id

Update a document.

**Auth Required:** Yes (must be document owner)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Document ID |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | No | 1-200 chars |
| abstract | string | No | Max 500 chars |
| content | object | No | TipTap JSON content |
| coverImageUrl | string | No | Valid URL |
| type | string | No | Document type |
| slug | string | No | Custom slug |
| typography | string | No | sans, serif, or mono |
| paperStyle | object | No | Paper style settings |
| paperTexture | object | No | Paper texture settings |
| coverSettings | object | No | Cover settings |
| documentHeader | object | No | Header configuration |
| documentFooter | object | No | Footer configuration |
| categoryId | string | No | Category ID (set to null to remove) |
| tags | string[] | No | Tag names — replaces all existing (max 5, empty array to remove all) |

**Note:** Editing content on a published document resets authorship and status to draft. You must re-publish to re-sign.

**Example Response (200):**
```json
{
  "data": {
    "id": "doc123abc...",
    "title": "Understanding Async/Await in JavaScript - Updated",
    "status": "draft",
    "authorship": null,
    ...
  },
  "error": null,
  "message": "Document updated"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`

---

### PATCH /api/v1/documents/:id/publish

Publish a document and generate its authorship signature.

**Auth Required:** Yes (must be document owner)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Document ID |

**Example Response (200):**
```json
{
  "data": {
    "id": "doc123abc...",
    "status": "published",
    "authorship": {
      "authorName": "John Doe",
      "username": "johndoe",
      "userHash": "abc123...",
      "documentHash": "def456...",
      "publicIdentifier": "PLT-xxxxxxxx.xxxxxxxx",
      "hmac": "hmac789...",
      "signedAt": "2024-03-01T15:30:00.000Z"
    },
    "publishedAt": "2024-03-01T15:30:00.000Z",
    ...
  },
  "error": null,
  "message": "Document published"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`

---

### DELETE /api/v1/documents/:id

Soft delete a document.

**Auth Required:** Yes (must be document owner)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Document ID |

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Document deleted"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

## Document Style Templates

### GET /api/v1/document-style-templates

List the authenticated user's style templates.

**Auth Required:** Yes

**Example Response (200):**
```json
{
  "data": [
    {
      "id": "tpl123abc...",
      "authorId": "prf123abc...",
      "name": "Academic Paper",
      "documentType": "article",
      "typography": "serif",
      "paperStyle": {
        "margins": "1in",
        "lineHeight": 1.6
      },
      "paperTexture": null,
      "documentHeader": {
        "showTitle": true,
        "showAuthor": true
      },
      "documentFooter": {
        "showPageNumber": true
      },
      "createdAt": "2024-02-01T10:00:00.000Z"
    }
  ],
  "error": null,
  "message": "Templates retrieved"
}
```

**Error Codes:** `UNAUTHORIZED`

---

### POST /api/v1/document-style-templates

Create a new style template.

**Auth Required:** Yes

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Max 50 chars |
| documentType | string | No | null = applies to any type |
| typography | string | Yes | sans, serif, or mono |
| paperStyle | object | No | Paper styling |
| paperTexture | object | No | Texture settings |
| documentHeader | object | No | Header configuration |
| documentFooter | object | No | Footer configuration |

**Example Request:**
```json
{
  "name": "Technical Documentation",
  "documentType": null,
  "typography": "mono",
  "paperStyle": {
    "margins": "1in"
  }
}
```

**Example Response (201):**
```json
{
  "data": {
    "id": "tpl456def...",
    "authorId": "prf123abc...",
    "name": "Technical Documentation",
    "documentType": null,
    "typography": "mono",
    ...
  },
  "error": null,
  "message": "Template created"
}
```

**Error Codes:** `UNAUTHORIZED`, `VALIDATION_ERROR`

---

### DELETE /api/v1/document-style-templates/:id

Delete a style template.

**Auth Required:** Yes (must be template owner)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Template ID |

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Template deleted"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

## Tutorial Exercises

### GET /api/v1/documents/:id/exercises

Get all exercises for a tutorial document. Answers are stripped from the response.

**Auth Required:** Yes

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Document ID |

**Example Response (200):**
```json
{
  "data": [
    {
      "id": "exr123abc...",
      "documentId": "doc123...",
      "type": "code",
      "data": {
        "prompt": "Write a function that returns 'Hello, World!'",
        "language": "javascript",
        "initialCode": "// Start here\n"
      },
      "createdAt": "2024-03-01T10:00:00.000Z",
      "updatedAt": "2024-03-01T10:00:00.000Z"
    },
    {
      "id": "exr456def...",
      "documentId": "doc123...",
      "type": "quiz",
      "data": {
        "question": "What does async/await simplify?",
        "options": [
          "Synchronous code",
          "Asynchronous code",
          "Type definitions",
          "Database queries"
        ]
      },
      "createdAt": "2024-03-01T10:05:00.000Z",
      "updatedAt": "2024-03-01T10:05:00.000Z"
    }
  ],
  "error": null,
  "message": "Exercises retrieved"
}
```

**Note:** `expectedOutput` and `correctIndex` are never returned to readers. TypeScript is transpiled via esbuild before execution.

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

### POST /api/v1/documents/:id/exercises

Create a new exercise for a tutorial document.

**Auth Required:** Yes (must be document owner)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Document ID |

**Request Body (code exercise):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | string | Yes | Must be "code" |
| data.prompt | string | Yes | Exercise description |
| data.language | string | Yes | Language: "javascript" or "typescript" |
| data.initialCode | string | Yes | Starter code shown to user |
| data.expectedOutput | string | Yes | Expected output for validation |

**Request Body (quiz exercise):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | string | Yes | Must be "quiz" |
| data.question | string | Yes | The question |
| data.options | string[] | Yes | 2-6 answer choices |
| data.correctIndex | number | Yes | Index of correct answer (0-based) |

**Example Request (code):**
```json
{
  "type": "code",
  "data": {
    "prompt": "Write a function that returns the sum of two numbers",
    "language": "javascript",
    "initialCode": "function sum(a, b) {\n  // your code here\n}",
    "expectedOutput": "3"
  }
}
```

**Example Response (201):**
```json
{
  "data": {
    "id": "exr789ghi...",
    "documentId": "doc123...",
    "type": "code",
    "data": {
      "prompt": "Write a function that returns the sum of two numbers",
      "language": "javascript",
      "initialCode": "function sum(a, b) {\n  // your code here\n}",
      "expectedOutput": "3"
    },
    "createdAt": "2024-03-01T12:00:00.000Z",
    "updatedAt": "2024-03-01T12:00:00.000Z"
  },
  "error": null,
  "message": "Exercise created"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`

---

### PATCH /api/v1/exercises/:id

Update an exercise.

**Auth Required:** Yes (must be document owner)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Exercise ID |

**Request Body:** Same as POST, but all fields are optional. Uses discriminated union on `type`.

**Example Request:**
```json
{
  "type": "code",
  "data": {
    "expectedOutput": "5"
  }
}
```

**Example Response (200):**
```json
{
  "data": {
    "id": "exr789ghi...",
    "type": "code",
    "data": {
      "prompt": "Write a function that returns the sum of two numbers",
      "language": "javascript",
      "initialCode": "function sum(a, b) {\n  // your code here\n}",
      "expectedOutput": "5"
    },
    "updatedAt": "2024-03-01T14:00:00.000Z"
  },
  "error": null,
  "message": "Exercise updated"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`

---

### DELETE /api/v1/exercises/:id

Delete an exercise.

**Auth Required:** Yes (must be document owner)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Exercise ID |

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Exercise deleted"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

### POST /api/v1/exercises/:id/submit

Submit an answer to an exercise.

**Auth Required:** Yes

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Exercise ID |

**Request Body (code submission):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | string | Yes | Must be "code" |
| code | string | Yes | User's code submission |

**Request Body (quiz submission):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | string | Yes | Must be "quiz" |
| answerIndex | number | Yes | Index of selected answer (0-based) |

**Example Request (code):**
```json
{
  "type": "code",
  "code": "function sum(a, b) {\n  return a + b;\n}\nconsole.log(sum(1, 2));"
}
```

**Example Response (200):**
```json
{
  "data": {
    "isCorrect": true,
    "attemptsCount": 3
  },
  "error": null,
  "message": "Answer submitted"
}
```

**Example Request (quiz):**
```json
{
  "type": "quiz",
  "answerIndex": 1
}
```

**Example Response (200):**
```json
{
  "data": {
    "isCorrect": false,
    "attemptsCount": 2
  },
  "error": null,
  "message": "Answer submitted"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`

---

## Books

> **Note:** All book routes require authentication. Books are not publicly accessible.

### GET /api/v1/books

Get a paginated feed of published books.

**Auth Required:** Yes

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| cursor | string | - | Opaque cursor for pagination |
| limit | integer | 20 | Results per page (max 50) |
| category | string | - | Filter by category slug |
| tag | string | - | Filter by tag slug |
| q | string | - | Search in title and description |
| sort | string | recent | Sort order: "recent" or "popular" |

**Example Response (200):**
```json
{
  "data": {
    "items": [
      {
        "id": "book123...",
        "title": "TypeScript Mastery",
        "description": "A comprehensive guide",
        "coverImageUrl": "https://example.com/cover.jpg",
        "slug": "typescript-mastery",
        "status": "published",
        "author": {
          "username": "johndoe",
          "displayName": "John Doe",
          "avatarUrl": "https://example.com/avatar.jpg"
        },
        "chapterCount": 8,
        "category": { "id": "cat123...", "name": "Programming", "slug": "programming" },
        "tags": [
          { "id": "tag123...", "name": "typescript", "slug": "typescript" }
        ],
        "updatedAt": "2024-02-15T10:00:00.000Z",
        "createdAt": "2024-01-01T00:00:00.000Z"
      }
    ],
    "nextCursor": null,
    "total": 5
  },
  "error": null,
  "message": "Books retrieved"
}
```

---

### GET /api/v1/books/me

Get all books created by the authenticated user.

**Auth Required:** Yes

**Example Response (200):**
```json
{
  "data": [
    {
      "id": "book123...",
      "title": "TypeScript Mastery",
      "status": "draft",
      "chapterCount": 3,
      ...
    }
  ],
  "error": null,
  "message": "Books retrieved"
}
```

---

### GET /api/v1/books/:username/:slug

Get a full book with chapters and reading progress.

**Auth Required:** Yes

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| username | string | Author's username |
| slug | string | Book slug |

**Example Response (200):**
```json
{
  "data": {
    "id": "book123...",
    "title": "TypeScript Mastery",
    "description": "A comprehensive guide",
    "coverImageUrl": "https://example.com/cover.jpg",
    "slug": "typescript-mastery",
    "status": "published",
    "author": {
      "username": "johndoe",
      "displayName": "John Doe",
      "avatarUrl": "https://example.com/avatar.jpg"
    },
    "category": { "id": "cat123...", "name": "Programming", "slug": "programming" },
    "tags": [...],
    "toc": [
      {
        "chapterId": "ch1...",
        "title": "Chapter 1: Getting Started",
        "headings": [
          { "level": 2, "text": "Installation", "anchor": "installation" },
          { "level": 2, "text": "Configuration", "anchor": "configuration" }
        ]
      }
    ],
    "authorship": {
      "authorName": "John Doe",
      "username": "johndoe",
      "userHash": "...",
      "documentHash": "...",
      "publicIdentifier": "PLT-xxxxxxxx.xxxxxxxx",
      "hmac": "...",
      "signedAt": "2024-02-15T10:00:00.000Z"
    },
    "chapters": [
      {
        "id": "ch1...",
        "position": 1,
        "introText": "Welcome to the first chapter...",
        "outroText": "In the next chapter we will...",
        "document": {
          "id": "doc123...",
          "title": "Getting Started with TypeScript",
          "abstract": "Learn the basics...",
          "slug": "getting-started-with-typescript"
        },
        "progress": {
          "isRead": true,
          "readAt": "2024-02-16T14:30:00.000Z"
        }
      }
    ],
    "progress": {
      "lastChapterId": "ch2..."
    }
  },
  "error": null,
  "message": "Book retrieved"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

### POST /api/v1/books

Create a new book.

**Auth Required:** Yes

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | Yes | 1-200 chars |
| description | string | No | Max 500 chars |
| coverImageUrl | string | No | Valid URL |
| slug | string | No | Custom slug (lowercase alphanumeric with hyphens) |
| categoryId | string | No | Category ID (required on publish) |
| tags | string[] | No | Tag names (max 5) |

**Example Request:**
```json
{
  "title": "TypeScript Mastery",
  "description": "A comprehensive guide to TypeScript",
  "categoryId": "cat123..."
}
```

**Example Response (201):**
```json
{
  "data": {
    "id": "book123...",
    "title": "TypeScript Mastery",
    "status": "draft",
    ...
  },
  "error": null,
  "message": "Book created"
}
```

---

### PATCH /api/v1/books/:id

Update a book.

**Auth Required:** Yes (must be book owner)

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | No | 1-200 chars |
| description | string | No | Max 500 chars |
| coverImageUrl | string | No | Valid URL |
| slug | string | No | Custom slug |
| categoryId | string | No | Category ID (set to null to remove) |
| tags | string[] | No | Tag names (max 5, replaces all) |

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`

---

### PATCH /api/v1/books/:id/publish

Publish a book. Generates authorship stamp and TOC.

**Auth Required:** Yes (must be book owner)

**Requirements:**
- Book must have at least one chapter
- Category must be assigned

**Example Response (200):**
```json
{
  "data": {
    "id": "book123...",
    "status": "published",
    "authorship": { ... },
    "toc": [ ... ]
  },
  "error": null,
  "message": "Book published"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`

---

### DELETE /api/v1/books/:id

Soft delete a book.

**Auth Required:** Yes (must be book owner)

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Book deleted"
}
```

---

### POST /api/v1/books/:id/chapters

Add a published document as a chapter to a draft book.

**Auth Required:** Yes (must be book owner)

**Note:** Book must be in draft status. Published books cannot have chapters added or removed.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| documentId | string | Yes | ID of a published document owned by the author |
| position | integer | No | Chapter position (appended at end if not provided) |
| introText | string | No | Transition text before chapter (max 1000) |
| outroText | string | No | Transition text after chapter (max 1000) |

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT`

---

### PATCH /api/v1/books/:id/chapters/:chapterId

Update a chapter's transition texts or reorder it.

**Auth Required:** Yes (must be book owner)

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| introText | string | No | Transition text before chapter |
| outroText | string | No | Transition text after chapter |
| position | integer | No | New position in the book |

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`

---

### DELETE /api/v1/books/:id/chapters/:chapterId

Remove a chapter from a book.

**Auth Required:** Yes (must be book owner)

**Note:** Book must be in draft status.

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`

---

### PATCH /api/v1/books/:id/chapters/reorder

Reorder chapters in a book.

**Auth Required:** Yes (must be book owner)

**Request Body:**
```json
{
  "chapters": [
    { "id": "ch1...", "position": 1 },
    { "id": "ch2...", "position": 2 },
    { "id": "ch3...", "position": 3 }
  ]
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`

---

### PATCH /api/v1/books/:id/toc

Manually update the table of contents.

**Auth Required:** Yes (must be book owner)

**Request Body:**
```json
{
  "toc": [
    {
      "chapterId": "ch1...",
      "title": "Chapter 1: Getting Started",
      "headings": [
        { "level": 2, "text": "Installation", "anchor": "installation" }
      ]
    }
  ]
}
```

**Note:** TOC is auto-generated when chapters are added, removed, or reordered. Use this to make manual edits.

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`

---

### PATCH /api/v1/books/:id/progress/:chapterId

Update reading progress on a chapter. Creates or updates book progress and chapter progress records.

**Auth Required:** Yes

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Progress updated"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

## Highlights

> **Note:** All highlight routes require authentication. Highlights are private — only the owner can see them.

### GET /api/v1/highlights/palette

Get the user's active highlight palette.

**Auth Required:** Yes

**Example Response (200):**
```json
{
  "data": {
    "colors": ["#FFF176", "#A5D6A7", "#90CAF9", "#F48FB1", "#CE93D8"],
    "isCustom": false
  },
  "error": null,
  "message": "Palette retrieved"
}
```

**Note:** `isCustom: false` means the default palette is in use (stored in code, not DB).

---

### PATCH /api/v1/highlights/palette

Update the user's highlight palette.

**Auth Required:** Yes

**Request Body:**
```json
{
  "colors": ["#FFEB3B", "#4CAF50", "#2196F3", "#E91E63", "#9C27B0"]
}
```

> **Constraint:** Exactly 5 valid hex colors required.

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Palette updated"
}
```

**Error Codes:** `UNAUTHORIZED`, `VALIDATION_ERROR`

---

### POST /api/v1/documents/:id/highlights

Create a highlight on a document.

**Auth Required:** Yes

**Request Body:**
```json
{
  "selection": {
    "text": "the highlighted text content",
    "color": "#FFF176",
    "position": {
      "nodeIndex": 3,
      "offsetStart": 15,
      "offsetEnd": 42
    }
  },
  "annotation": null
}
```

> **Constraint:** `color` must match one of the user's 5 palette colors.

**Example Response (201):**
```json
{
  "data": {
    "id": "hl123...",
    "documentId": "doc123...",
    "selection": { ... },
    "annotation": null,
    "createdAt": "2024-02-15T10:00:00.000Z",
    "updatedAt": "2024-02-15T10:00:00.000Z"
  },
  "error": null,
  "message": "Highlight created"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`

---

### GET /api/v1/highlights/me

Get all highlights for the authenticated user, grouped by document.

**Auth Required:** Yes

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| cursor | string | - | Pagination cursor |
| limit | integer | 20 | Results per page (max 50) |

**Example Response (200):**
```json
{
  "data": {
    "items": [
      {
        "document": {
          "id": "doc123...",
          "title": "Getting Started with TypeScript",
          "slug": "getting-started-with-typescript",
          "authorUsername": "johndoe"
        },
        "highlights": [
          {
            "id": "hl1...",
            "documentId": "doc123...",
            "selection": {
              "text": "TypeScript is a typed superset of JavaScript",
              "color": "#FFF176",
              "position": { "nodeIndex": 2, "offsetStart": 0, "offsetEnd": 47 }
            },
            "annotation": null,
            "createdAt": "2024-02-15T10:00:00.000Z",
            "updatedAt": "2024-02-15T10:00:00.000Z"
          }
        ]
      }
    ],
    "nextCursor": null,
    "total": 3
  },
  "error": null,
  "message": "Highlights retrieved"
}
```

**Note:** Highlights within each document are ordered by `createdAt` DESC. Use `GET /documents/:id/highlights/me` for reading order.

---

### GET /api/v1/documents/:id/highlights/me

Get highlights on a specific document in reading order.

**Auth Required:** Yes

**Use case:** Render a user's highlights while reading a document.

**Example Response (200):**
```json
{
  "data": [
    {
      "id": "hl1...",
      "documentId": "doc123...",
      "selection": {
        "text": "TypeScript is a typed superset",
        "color": "#FFF176",
        "position": { "nodeIndex": 0, "offsetStart": 0, "offsetEnd": 35 }
      },
      "annotation": null,
      "createdAt": "2024-02-15T10:00:00.000Z",
      "updatedAt": "2024-02-15T10:00:00.000Z"
    }
  ],
  "error": null,
  "message": "Highlights retrieved"
}
```

**Note:** Highlights are sorted by `nodeIndex` ASC, then `offsetStart` ASC — matching document reading order.

---

### PATCH /api/v1/highlights/:id

Update a highlight's selection or annotation.

**Auth Required:** Yes

**Request Body:**
```json
{
  "selection": {
    "text": "updated highlighted text",
    "color": "#A5D6A7",
    "position": { "nodeIndex": 1, "offsetStart": 10, "offsetEnd": 30 }
  },
  "annotation": {
    "type": "doc",
    "content": [{ "type": "text", "text": "My note about this passage" }]
  }
}
```

> **Constraint:** If `color` is changed, it must still be in your palette.

**Example Response (200):**
```json
{
  "data": { ... },
  "error": null,
  "message": "Highlight updated"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`

---

### DELETE /api/v1/highlights/:id

Delete a highlight.

**Auth Required:** Yes

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Highlight deleted"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

## Journals (Auth Required)

Journals are personal collections of highlights. Each user can have a maximum of 2 journals.

**Notes:**
- Maximum 2 journals per account (hard limit enforced in service)
- Journals belong to the user's personal workspace
- Highlights are added manually — never auto-populated
- Removing a highlight from a journal does NOT delete the highlight itself
- Highlights are ordered by position (ascending)

### POST /api/v1/journals

Create a new journal.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | Yes | Journal title (max 200 chars) |
| description | string | No | Description (max 500 chars) |
| color | string | No | Color from NOTE_COLORS (default: "indigo") |

**Example Request:**
```json
{
  "title": "Reading List",
  "description": "Highlights from programming tutorials",
  "color": "indigo"
}
```

**Example Response (201):**
```json
{
  "data": {
    "id": "jrn123abc...",
    "workspaceId": "ws123abc...",
    "title": "Reading List",
    "description": "Highlights from programming tutorials",
    "color": "indigo",
    "deletedAt": null,
    "createdAt": "2024-02-15T10:00:00.000Z",
    "updatedAt": "2024-02-15T10:00:00.000Z"
  },
  "error": null,
  "message": "Journal created"
}
```

**Error Codes:** `VALIDATION_ERROR` (includes limit reached)

---

### GET /api/v1/journals

List all journals for the current user.

**Example Response (200):**
```json
{
  "data": [
    {
      "id": "jrn123abc...",
      "workspaceId": "ws123abc...",
      "title": "Reading List",
      "description": "Highlights from programming tutorials",
      "color": "indigo",
      "deletedAt": null,
      "createdAt": "2024-02-15T10:00:00.000Z",
      "updatedAt": "2024-02-15T10:00:00.000Z",
      "highlightCount": 5
    }
  ],
  "error": null,
  "message": "Journals retrieved"
}
```

**Error Codes:** `UNAUTHORIZED`

---

### GET /api/v1/journals/:id

Get a journal with all its highlights.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Journal ID |

**Example Response (200):**
```json
{
  "data": {
    "id": "jrn123abc...",
    "workspaceId": "ws123abc...",
    "title": "Reading List",
    "description": "Highlights from programming tutorials",
    "color": "indigo",
    "createdAt": "2024-02-15T10:00:00.000Z",
    "updatedAt": "2024-02-15T10:00:00.000Z",
    "highlights": [
      {
        "id": "jh123abc...",
        "journalId": "jrn123abc...",
        "highlightId": "hl456def...",
        "position": 0,
        "createdAt": "2024-02-15T10:00:00.000Z",
        "highlight": {
          "id": "hl456def...",
          "userId": "usr789ghi...",
          "documentId": "doc123abc...",
          "selection": {
            "text": "The highlighted text",
            "color": "yellow",
            "position": { "nodeIndex": 2, "offsetStart": 10, "offsetEnd": 45 }
          },
          "annotation": { "note": "Important concept" },
          "createdAt": "2024-02-15T10:00:00.000Z",
          "updatedAt": "2024-02-15T10:00:00.000Z",
          "document": {
            "id": "doc123abc...",
            "title": "Getting Started with TypeScript",
            "slug": "getting-started-with-typescript",
            "authorUsername": "johndoe"
          }
        }
      }
    ]
  },
  "error": null,
  "message": "Journal retrieved"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

### PATCH /api/v1/journals/:id

Update a journal.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Journal ID |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | No | Journal title (max 200 chars) |
| description | string | No | Description (max 500 chars) |
| color | string | No | Color from NOTE_COLORS |

**Example Response (200):**
```json
{
  "data": {
    "id": "jrn123abc...",
    "title": "Reading List (Updated)",
    "description": "Updated description",
    "color": "violet",
    ...
  },
  "error": null,
  "message": "Journal updated"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`

---

### DELETE /api/v1/journals/:id

Soft delete a journal.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Journal ID |

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Journal deleted"
}
```

**Note:** Journal highlights are preserved in case of restoration.

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

### POST /api/v1/journals/:id/highlights

Add a highlight to a journal.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Journal ID |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| highlightId | string | Yes | The highlight ID to add |
| position | integer | No | Position in journal (appended at end if omitted) |

**Example Request:**
```json
{
  "highlightId": "hl456def...",
  "position": 0
}
```

**Example Response (201):**
```json
{
  "data": {
    "id": "jh123abc...",
    "journalId": "jrn123abc...",
    "highlightId": "hl456def...",
    "position": 0,
    "createdAt": "2024-02-15T10:00:00.000Z"
  },
  "error": null,
  "message": "Highlight added to journal"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `CONFLICT`

---

### DELETE /api/v1/journals/:id/highlights/:highlightId

Remove a highlight from a journal.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Journal ID |
| highlightId | string | Highlight ID to remove |

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Highlight removed from journal"
}
```

**Note:** This does NOT delete the highlight itself — only removes the journal reference. Remaining highlights are reordered automatically.

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

### PATCH /api/v1/journals/:id/highlights/reorder

Reorder highlights within a journal.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Journal ID |

**Request Body:**

```json
{
  "highlights": [
    { "id": "hl1...", "position": 0 },
    { "id": "hl2...", "position": 1 },
    { "id": "hl3...", "position": 2 }
  ]
}
```

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Highlights reordered"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`

---

## Follows (Auth Required)

Follow system with support for private profiles.

**Notes:**
- Profiles can be public (follow immediate) or private (follow requires approval)
- Private profiles hide content from non-followers
- `is_following` = true only if status = 'accepted', null for unauthenticated
- `follow_status` values: 'accepted', 'pending', 'rejected', null

### GET /api/v1/profiles/:username/followers

Get followers of a profile. Returns `{ hidden: true }` for private profiles when viewer is not an accepted follower.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| username | string | Profile username |

**Example Response (200) - Public Profile:**
```json
{
  "data": {
    "items": [
      {
        "follower": {
          "id": "prf123...",
          "username": "johndoe",
          "displayName": "John Doe",
          "avatarUrl": "https://example.com/avatar.jpg"
        },
        "createdAt": "2024-02-15T10:00:00.000Z"
      }
    ],
    "count": 42
  },
  "error": null,
  "message": "Followers retrieved"
}
```

**Example Response (200) - Private Profile (hidden):**
```json
{
  "data": {
    "hidden": true,
    "items": [],
    "count": 0
  },
  "error": null,
  "message": "Followers retrieved"
}
```

**Error Codes:** `UNAUTHORIZED`

---

### GET /api/v1/profiles/:username/following

Get following list of a profile. Same privacy rules as followers.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| username | string | Profile username |

**Example Response (200):**
```json
{
  "data": {
    "items": [
      {
        "following": {
          "id": "prf456...",
          "username": "janedoe",
          "displayName": "Jane Doe",
          "avatarUrl": "https://example.com/avatar2.jpg"
        },
        "createdAt": "2024-02-15T10:00:00.000Z"
      }
    ],
    "count": 15
  },
  "error": null,
  "message": "Following retrieved"
}
```

**Error Codes:** `UNAUTHORIZED`

---

### POST /api/v1/profiles/:username/follow

Follow a profile.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| username | string | Profile username to follow |

**Example Response (201) - Public Profile:**
```json
{
  "data": {
    "status": "accepted"
  },
  "error": null,
  "message": "Following"
}
```

**Example Response (201) - Private Profile:**
```json
{
  "data": {
    "status": "pending"
  },
  "error": null,
  "message": "Follow request sent"
}
```

**Error Codes:** `UNAUTHORIZED`, `VALIDATION_ERROR` (follow yourself), `CONFLICT` (already following/pending)

---

### DELETE /api/v1/profiles/:username/follow

Unfollow a profile.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| username | string | Profile username to unfollow |

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Unfollowed"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

### GET /api/v1/feed/following

Get a feed of published documents from followed profiles.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| cursor | string | - | Opaque cursor for pagination |
| limit | integer | 20 | Results per page (max 50) |

**Example Response (200):**
```json
{
  "data": {
    "items": [
      {
        "id": "doc123...",
        "title": "Getting Started with TypeScript",
        "abstract": "A comprehensive guide",
        "slug": "getting-started-with-typescript",
        "publishedAt": "2024-02-15T10:00:00.000Z",
        "typeName": "article",
        "author": {
          "username": "johndoe",
          "displayName": "John Doe"
        },
        "likesCount": 42
      }
    ],
    "nextCursor": "eyJw...",
    "total": 20
  },
  "error": null,
  "message": "Following feed retrieved"
}
```

**Note:** Excludes documents from private profiles where viewer is not an accepted follower.

**Error Codes:** `UNAUTHORIZED`

---

### GET /api/v1/follows/requests

Get pending follow requests (for private profile owners).

**Example Response (200):**
```json
{
  "data": [
    {
      "id": "flw123...",
      "follower": {
        "id": "prf456...",
        "username": "johndoe",
        "displayName": "John Doe",
        "avatarUrl": "https://example.com/avatar.jpg"
      },
      "createdAt": "2024-02-15T10:00:00.000Z"
    }
  ],
  "error": null,
  "message": "Pending requests retrieved"
}
```

**Error Codes:** `UNAUTHORIZED`

---

### POST /api/v1/follows/requests/:id/accept

Accept a follow request.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Follow request ID |

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Follow request accepted"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

### DELETE /api/v1/follows/requests/:id/reject

Reject a follow request.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Follow request ID |

**Example Response (200):**
```json
{
  "data": null,
  "error": null,
  "message": "Follow request rejected"
}
```

**Error Codes:** `UNAUTHORIZED`, `NOT_FOUND`

---

### GET /api/v1/profiles/:username

Profile response now includes follow-related fields for authenticated requests:

```json
{
  "data": {
    "username": "johndoe",
    "displayName": "John Doe",
    "bio": "Hello world",
    "bioPrivate": "Welcome to my profile",
    "avatarUrl": "https://example.com/avatar.jpg",
    "isPrivate": false,
    "isFollowing": true,
    "followStatus": "accepted",
    ...
  },
  "error": null,
  "message": "Profile retrieved"
}
```

**Notes:**
- For private profiles with non-follower: returns limited data (username, displayName, avatarUrl, bioPrivate, isPrivate)
- `isFollowing`: true if status = 'accepted', null for unauthenticated
- `followStatus`: 'accepted' | 'pending' | 'rejected' | null

### PATCH /api/v1/profiles/me

Update profile now supports privacy settings:

| Field | Type | Description |
|-------|------|-------------|
| isPrivate | boolean | Make profile private (default: false) |
| bioPrivate | string | Bio shown to non-followers (max 150 chars) |

**Example Request:**
```json
{
  "bio": "Full bio for followers",
  "bioPrivate": "Welcome! This is a private profile.",
  "isPrivate": true
}
```

---

## Error Codes Reference

| Code | HTTP Status | Description |
|------|-------------|-------------|
| VALIDATION_ERROR | 400 | Request body/params failed validation |
| UNAUTHORIZED | 401 | Missing or invalid JWT token |
| NOT_FOUND | 404 | Resource not found |
| CONFLICT | 409 | Resource already exists (e.g., duplicate email) |
| RATE_LIMITED | 429 | Too many requests |
| INTERNAL_ERROR | 500 | Unexpected server error |
