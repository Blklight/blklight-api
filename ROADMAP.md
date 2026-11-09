# blklight API Roadmap

> This file is mirrored at docs/ROADMAP.md

This roadmap defines which API features/routes to enable and expose per phase.
Each phase builds on the previous. Routes marked **[internal]** exist and are
tested but not mounted on the server in that phase.

---

## Pre-MVP — Setup & Infrastructure

Goal: Environment ready, database seeded, API responding.

### Infrastructure checklist

- ✓ Docker running (`docker compose up -d`)
- ✓ PostgreSQL responding
- ✓ pgvector extension enabled (`CREATE EXTENSION IF NOT EXISTS vector`)
- ✓ Migrations applied (`npm run db:migrate`)
- ✓ Seed executed (`npm run db:seed`) — includes platform_apps
- ✓ Environment variables configured (`.env.development`)
- ✓ Server starts without errors (`npm run dev`)
- ✓ Feature flags configured with safe defaults
- ✓ Health check green (`GET /health` returns 200)
- ✓ API docs accessible (`GET /docs` loads Scalar)

### Routes available in this phase

| Method | Endpoint |
| ------ | -------- |
| GET    | /health  |
| GET    | /docs    |

### Tests to pass before moving to MVP

- auth.service tests ✓
- documents.service tests ✓
- signatures.service tests ✓

### Security gates

- Fix all CRITICAL and HIGH findings from `docs/SECURITY.md`

---

## MVP — Personal Space (Private-First)

Goal: The user has a complete, intelligent personal space before anything is
public. Canvas, notes, memory, and onboarding are the full experience.
Documents, books, and social features exist in the codebase but are not
exposed yet.

### Principle: internal vs exposed

A route being **[internal]** means it exists and is implemented but is not
registered on the Fastify server in this phase. Feature flags handle this —
no routes are deleted, only conditionally mounted. The /docs Scalar page
only shows routes that are currently mounted.

---

### Auth & Onboarding

Onboarding flow differs by registration method:

**Email registration:**

1. POST /api/v1/auth/register — creates user + profile + signature + workspace + canvas atomically
2. Frontend redirects to app selection
3. POST /api/v1/platform-apps/me — activates chosen apps, sets onboarding_complete = true
4. Frontend redirects to dashboard

**OAuth registration:**

1. OAuth flow completes
2. POST /api/v1/auth/onboarding — username chosen, profile + signature + workspace + canvas created atomically
3. Frontend redirects to app selection
4. POST /api/v1/platform-apps/me — activates chosen apps, sets onboarding_complete = true
5. Frontend redirects to dashboard

| Method | Endpoint                              | Exposed    | Notes               |
| ------ | ------------------------------------- | ---------- | ------------------- |
| POST   | /api/v1/auth/register                 | Yes        |                     |
| POST   | /api/v1/auth/login                    | Yes        |                     |
| POST   | /api/v1/auth/refresh                  | Yes        |                     |
| POST   | /api/v1/auth/logout                   | Yes        |                     |
| POST   | /api/v1/auth/verify-email             | Yes        |                     |
| POST   | /api/v1/auth/resend-verification      | Yes        |                     |
| POST   | /api/v1/auth/forgot-password          | Yes        |                     |
| POST   | /api/v1/auth/reset-password           | Yes        |                     |
| GET    | /api/v1/auth/github                   | Yes (flag) | FEATURE_OAUTH       |
| GET    | /api/v1/auth/github/callback          | Yes (flag) | FEATURE_OAUTH       |
| GET    | /api/v1/auth/google                   | Yes (flag) | FEATURE_OAUTH       |
| GET    | /api/v1/auth/google/callback          | Yes (flag) | FEATURE_OAUTH       |
| POST   | /api/v1/auth/onboarding               | Yes        | OAuth username step |
| GET    | /api/v1/auth/github/link              | Internal   | Reserved for Beta   |
| GET    | /api/v1/auth/google/link              | Internal   | Reserved for Beta   |
| DELETE | /api/v1/auth/account/unlink/:provider | Internal   | Reserved for Beta   |

---

### Platform Apps

| Method | Endpoint                        | Exposed | Notes                                 |
| ------ | ------------------------------- | ------- | ------------------------------------- |
| GET    | /api/v1/platform-apps           | Yes     | Public catalog — no auth needed       |
| GET    | /api/v1/platform-apps/me        | Yes     | User's activated apps                 |
| POST   | /api/v1/platform-apps/me        | Yes     | Activate apps (onboarding + settings) |
| DELETE | /api/v1/platform-apps/me/:appId | Yes     | Deactivate an app                     |

Apps seeded at launch: canvas, publisher, reader, dev-tools.
Only canvas is meaningfully usable in MVP — others visible but content routes are internal.

---

### Profile

| Method | Endpoint                   | Exposed  | Notes               |
| ------ | -------------------------- | -------- | ------------------- |
| GET    | /api/v1/profiles/me        | Yes      |                     |
| PATCH  | /api/v1/profiles/me        | Yes      |                     |
| GET    | /api/v1/profiles/:username | Yes      | Public profile view |
| DELETE | /api/v1/profiles/me        | Internal | Reserved for Beta   |

---

### Workspace

| Method | Endpoint                          | Exposed |
| ------ | --------------------------------- | ------- |
| GET    | /api/v1/workspace/me              | Yes     |
| PATCH  | /api/v1/workspace/me/color-labels | Yes     |

---

### Canvas & Notes (post-its)

The primary creative surface in MVP. Canvas is the spatial container.
Notes are the post-its that live inside it.

| Method | Endpoint                    | Exposed | Notes                                      |
| ------ | --------------------------- | ------- | ------------------------------------------ |
| GET    | /api/v1/canvas/me           | Yes     | Canvas with all notes + positions          |
| PATCH  | /api/v1/canvas/me/positions | Yes     | Batch update note positions                |
| POST   | /api/v1/notes               | Yes     | Create note — triggers memory job          |
| GET    | /api/v1/notes               | Yes     | List notes (paginated, filterable)         |
| GET    | /api/v1/notes/:id           | Yes     | Get note by ID                             |
| PATCH  | /api/v1/notes/:id           | Yes     | Update note — re-indexes embedding         |
| DELETE | /api/v1/notes/:id           | Yes     | Soft delete — removes position + embedding |

---

### Semantic Memory

Indexes note content in background. Works standalone — does not depend on
documents, books, or any other feature being exposed.

| Method | Endpoint                                     | Exposed | Notes                     |
| ------ | -------------------------------------------- | ------- | ------------------------- |
| GET    | /api/v1/memory/search                        | Yes     | ?q=string&limit=10        |
| GET    | /api/v1/memory/related/:sourceType/:sourceId | Yes     | Related items for a note  |
| GET    | /api/v1/memory/digest                        | Yes     | Weekly connections digest |

Memory indexing in MVP covers: notes only.
Expands to documents in Beta, journal_highlights and book_chapters in v1.0.

Indexing triggers in MVP:

- POST /api/v1/notes — void indexSource('note', note.id, userId)
- PATCH /api/v1/notes/:id — re-index after update
- DELETE /api/v1/notes/:id — remove embedding row

Feature flag: FEATURE_MEMORY=true (default). If GEMINI_API_KEY is missing,
flag is silently treated as false — notes save normally.

---

### Categories & Tags (read-only, public)

| Method | Endpoint                 | Exposed    |
| ------ | ------------------------ | ---------- |
| GET    | /api/v1/categories       | Yes        |
| GET    | /api/v1/categories/:slug | Yes        |
| GET    | /api/v1/tags/popular     | Yes        |
| POST   | /api/v1/categories       | Admin only |
| PATCH  | /api/v1/categories/:id   | Admin only |
| DELETE | /api/v1/categories/:id   | Admin only |

---

### What exists but is NOT exposed in MVP

| Feature                    | Why internal                               |
| -------------------------- | ------------------------------------------ |
| Documents (CRUD + publish) | Public publishing unlocked in Beta         |
| Tutorial exercises         | Depends on published documents             |
| Likes & bookmarks          | Depends on public documents                |
| Highlights                 | Depends on published documents             |
| Journals                   | Depends on highlights                      |
| Books                      | Depends on published documents as chapters |
| Follows & social feed      | Social layer unlocked in v1.0              |
| Document style templates   | Unlocked alongside documents in Beta       |
| Account linking/unlinking  | Unlocked in Beta                           |
| Profile deletion           | Unlocked in Beta                           |

---

### Tests to pass before MVP launch

- auth.service tests ✓
- profiles.service tests ✓
- platform-apps.service tests ✓
- workspace.service tests ✓
- canvas.service tests ✓
- notes.service tests ✓
- memory.service tests ✓
- memory.job tests ✓

### Security gates

- Fix all CRITICAL and HIGH findings from `docs/SECURITY.md`

---

## Beta — Creative Publishing

Goal: The user can write and publish content publicly. Memory expands to
index documents. Engagement features unlocked. Account management complete.

### What becomes exposed in Beta (on top of MVP)

#### Documents

| Method | Endpoint                             | Exposed                  |
| ------ | ------------------------------------ | ------------------------ |
| GET    | /api/v1/documents                    | Yes — public feed        |
| GET    | /api/v1/documents/:username/:slug    | Yes — public             |
| GET    | /api/v1/documents/me                 | Yes                      |
| POST   | /api/v1/documents                    | Yes                      |
| PATCH  | /api/v1/documents/:id                | Yes                      |
| PATCH  | /api/v1/documents/:id/publish        | Yes                      |
| DELETE | /api/v1/documents/:id                | Yes                      |
| GET    | /api/v1/profiles/:username/documents | Yes — public author feed |

Memory indexing hook added: documents indexed on publish, removed on delete.

#### Tutorial Exercises

| Method | Endpoint                        | Exposed |
| ------ | ------------------------------- | ------- |
| GET    | /api/v1/documents/:id/exercises | Yes     |
| POST   | /api/v1/documents/:id/exercises | Yes     |
| PATCH  | /api/v1/exercises/:id           | Yes     |
| DELETE | /api/v1/exercises/:id           | Yes     |
| POST   | /api/v1/exercises/:id/submit    | Yes     |

#### Likes & Bookmarks

| Method | Endpoint                       | Exposed |
| ------ | ------------------------------ | ------- |
| POST   | /api/v1/documents/:id/like     | Yes     |
| GET    | /api/v1/documents/:id/likes    | Yes     |
| POST   | /api/v1/documents/:id/bookmark | Yes     |
| GET    | /api/v1/bookmarks/me           | Yes     |

#### Highlights & Journals

| Method | Endpoint                                     | Exposed |
| ------ | -------------------------------------------- | ------- |
| POST   | /api/v1/documents/:id/highlights             | Yes     |
| GET    | /api/v1/documents/:id/highlights/me          | Yes     |
| GET    | /api/v1/highlights/me                        | Yes     |
| PATCH  | /api/v1/highlights/:id                       | Yes     |
| DELETE | /api/v1/highlights/:id                       | Yes     |
| GET    | /api/v1/highlights/palette                   | Yes     |
| PATCH  | /api/v1/highlights/palette                   | Yes     |
| POST   | /api/v1/journals                             | Yes     |
| GET    | /api/v1/journals                             | Yes     |
| GET    | /api/v1/journals/:id                         | Yes     |
| PATCH  | /api/v1/journals/:id                         | Yes     |
| DELETE | /api/v1/journals/:id                         | Yes     |
| POST   | /api/v1/journals/:id/highlights              | Yes     |
| DELETE | /api/v1/journals/:id/highlights/:highlightId | Yes     |
| PATCH  | /api/v1/journals/:id/highlights/reorder      | Yes     |

#### Document Style Templates

| Method | Endpoint                             | Exposed |
| ------ | ------------------------------------ | ------- |
| GET    | /api/v1/document-style-templates     | Yes     |
| POST   | /api/v1/document-style-templates     | Yes     |
| DELETE | /api/v1/document-style-templates/:id | Yes     |

#### Account Management

| Method | Endpoint                              | Exposed    |
| ------ | ------------------------------------- | ---------- |
| DELETE | /api/v1/profiles/me                   | Yes        |
| POST   | /api/v1/auth/github/link              | Yes (flag) |
| GET    | /api/v1/auth/github/link/start        | Cookie (flag) |
| POST   | /api/v1/auth/google/link              | Yes (flag) |
| GET    | /api/v1/auth/google/link/start        | Cookie (flag) |
| DELETE | /api/v1/auth/account/unlink/:provider | Yes        |

### Tests to pass before Beta release

- tutorial-exercises.service tests ✓
- sandbox tests ✓
- highlights.service tests ✓
- journals.service tests ✓
- memory.service (document indexing) tests ✓

### Security gates

- Fix all MEDIUM findings from `docs/SECURITY.md`

---

## v1.0 — Social & Long-Form

Goal: Social features, curated content, personal library. Memory reaches
full coverage across all content types.

### Books

| Method | Endpoint                              | Exposed           |
| ------ | ------------------------------------- | ----------------- |
| POST   | /api/v1/books                         | Yes               |
| PATCH  | /api/v1/books/:id                     | Yes               |
| PATCH  | /api/v1/books/:id/publish             | Yes               |
| DELETE | /api/v1/books/:id                     | Yes               |
| GET    | /api/v1/books/me                      | Yes               |
| GET    | /api/v1/books                         | Yes — public feed |
| GET    | /api/v1/books/:username/:slug         | Yes               |
| POST   | /api/v1/books/:id/chapters            | Yes               |
| PATCH  | /api/v1/books/:id/chapters/:chapterId | Yes               |
| DELETE | /api/v1/books/:id/chapters/:chapterId | Yes               |
| PATCH  | /api/v1/books/:id/chapters/reorder    | Yes               |
| PATCH  | /api/v1/books/:id/toc                 | Yes               |
| PATCH  | /api/v1/books/:id/progress/:chapterId | Yes               |

### Follows & Social Feed

| Method | Endpoint                             | Exposed |
| ------ | ------------------------------------ | ------- |
| POST   | /api/v1/profiles/:username/follow    | Yes     |
| DELETE | /api/v1/profiles/:username/follow    | Yes     |
| GET    | /api/v1/profiles/:username/followers | Yes     |
| GET    | /api/v1/profiles/:username/following | Yes     |
| GET    | /api/v1/feed/following               | Yes     |
| GET    | /api/v1/follows/requests             | Yes     |
| POST   | /api/v1/follows/requests/:id/accept  | Yes     |
| DELETE | /api/v1/follows/requests/:id/reject  | Yes     |

### Memory — full coverage in v1.0

| Source             | Indexed field                     | Trigger                   |
| ------------------ | --------------------------------- | ------------------------- |
| notes              | title + content                   | create, update, delete    |
| documents          | title + abstract                  | publish, re-draft, delete |
| journal_highlights | highlight text                    | add to journal, remove    |
| book_chapters      | chapter document title + abstract | book publish, delete      |

Semantic search returns unified results across all four source types.

### Tests to pass before v1.0 release

- books.service tests ✓
- follows.service tests ✓
- memory.service (full coverage) tests ✓

### Security gates

- Fix all LOW findings from `docs/SECURITY.md`

---

## Future (post v1.0)

- Memory map — visual cluster view of user's ideas (canvas-based)
- Memory digest Pro tier — richer weekly email with trend analysis
- Comments on documents
- Sharevault (public workspace layer with PIN protection)
- Team workspaces (workspace_members routes)
- Contract signatures (document_signatures)
- Blockchain migration for signatures (tx_hash — Solana or Base)
- Notifications system
- Analytics & reading stats
- RSS feeds
- API rate limiting per user tier
- Monetization & plans (Free / Pro based on memory history limit)
- Admin panel
- Full-text search (PostgreSQL tsvector — complements semantic search)
