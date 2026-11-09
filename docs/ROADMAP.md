# blklight API Roadmap

> This file is mirrored at ROADMAP.md

This roadmap defines which API features/routes to enable and test per phase. Each phase builds on the previous.

---

## Pre-MVP — Setup & Infrastructure

Goal: Environment ready, database seeded, API responding.
No user-facing features yet — just the foundation.

### Infrastructure checklist

- ✓ Docker running (`docker compose up -d`)
- ✓ PostgreSQL responding (`docker ps` shows healthy)
- ✓ Migrations applied (`npm run db:migrate`)
- ✓ Seed executed (`npm run db:seed`)
- ✓ Environment variables configured (`.env.development`)
- ✓ Server starts without errors (`npm run dev`)
- ✓ Feature flags configured (`.env.development` with safe defaults)
- ✓ Server starts with FEATURE_EMAIL=false (no Resend needed)
- ✓ Server starts with FEATURE_OAUTH=false (no OAuth keys needed)
- ✓ Health check green (`GET /health` returns 200)
- ✓ API docs accessible (`GET /docs` loads Scalar)

### Routes available in this phase

| Method | Endpoint |
|--------|----------|
| GET | /health |
| GET | /docs |

### Admin setup (manual via Drizzle Studio or SQL)

- Create first admin account
- Verify categories seeded correctly (`npm run db:studio`)
- Verify tags seeded correctly

### Tests to pass before moving to MVP

- `npm test` passes (all utils tests green)
- `tsc --noEmit` passes (zero TypeScript errors)

---

## MVP — Minimum Viable Product

Goal: Users can create accounts, write and publish content.
Platform is functional but not yet social.

### Auth

| Method | Endpoint |
|--------|----------|
| POST | /api/v1/auth/register |
| POST | /api/v1/auth/login |
| POST | /api/v1/auth/refresh |
| POST | /api/v1/auth/logout |
| GET | /api/v1/auth/github |
| GET | /api/v1/auth/github/callback |
| GET | /api/v1/auth/google |
| GET | /api/v1/auth/google/callback |
| POST | /api/v1/auth/onboarding |

### Profiles

| Method | Endpoint |
|--------|----------|
| GET | /api/v1/profiles/:username |
| GET | /api/v1/profiles/me |
| PATCH | /api/v1/profiles/me |

### Documents

| Method | Endpoint |
|--------|----------|
| POST | /api/v1/documents |
| PATCH | /api/v1/documents/:id |
| PATCH | /api/v1/documents/:id/publish |
| GET | /api/v1/documents (public feed) |
| GET | /api/v1/documents/:username/:slug |
| GET | /api/v1/documents/me |

### Categories & Tags (public read)

| Method | Endpoint |
|--------|----------|
| GET | /api/v1/categories |
| GET | /api/v1/categories/:slug |
| GET | /api/v1/tags/popular |

### Admin (categories management)

| Method | Endpoint |
|--------|----------|
| POST | /api/v1/admin/categories |
| PATCH | /api/v1/admin/categories/:id |
| DELETE | /api/v1/admin/categories/:id |

### Tests to pass before MVP release

- auth.service tests ✓
- documents.service tests ✓
- signatures.service tests ✓

### Security gates

- Fix all CRITICAL and HIGH findings from `docs/SECURITY.md`
- See `docs/SECURITY_REMEDIATION.md` for details

---

## Beta

Goal: Engagement, personal space, and learning content.

### Workspace & Notes

| Method | Endpoint |
|--------|----------|
| GET | /api/v1/workspace/me |
| PATCH | /api/v1/workspace/me/color-labels |
| POST | /api/v1/notes |
| GET | /api/v1/notes |
| GET | /api/v1/notes/:id |
| PATCH | /api/v1/notes/:id |
| DELETE | /api/v1/notes/:id |

### Tutorial Exercises

| Method | Endpoint |
|--------|----------|
| GET | /api/v1/documents/:id/exercises |
| POST | /api/v1/documents/:id/exercises |
| PATCH | /api/v1/exercises/:id |
| DELETE | /api/v1/exercises/:id |
| POST | /api/v1/exercises/:id/submit |

### Likes & Bookmarks

| Method | Endpoint |
|--------|----------|
| POST | /api/v1/documents/:id/like |
| GET | /api/v1/documents/:id/likes |
| POST | /api/v1/documents/:id/bookmark |
| GET | /api/v1/bookmarks/me |

### Account management

| Method | Endpoint |
|--------|----------|
| DELETE | /api/v1/profiles/me |
| DELETE | /api/v1/auth/account/unlink/:provider |
| POST | /api/v1/auth/github/link |
| GET | /api/v1/auth/github/link/start |
| POST | /api/v1/auth/google/link |
| GET | /api/v1/auth/google/link/start |

### Tests to pass before Beta release

- workspace.service tests ✓
- notes.service tests ✓
- tutorial-exercises.service tests ✓
- sandbox tests ✓

### Security gates

- Fix all MEDIUM findings from `docs/SECURITY.md`
- See `docs/SECURITY_REMEDIATION.md` for details

---

## v1.0

Goal: Social features, curated content, personal library.

### Books

| Method | Endpoint |
|--------|----------|
| POST | /api/v1/books |
| PATCH | /api/v1/books/:id |
| PATCH | /api/v1/books/:id/publish |
| DELETE | /api/v1/books/:id |
| GET | /api/v1/books/me |
| GET | /api/v1/books (public feed) |
| GET | /api/v1/books/:username/:slug |
| POST | /api/v1/books/:id/chapters |
| PATCH | /api/v1/books/:id/chapters/:chapterId |
| DELETE | /api/v1/books/:id/chapters/:chapterId |
| PATCH | /api/v1/books/:id/chapters/reorder |
| PATCH | /api/v1/books/:id/toc |
| PATCH | /api/v1/books/:id/progress/:chapterId |

### Highlights & Journals

| Method | Endpoint |
|--------|----------|
| POST | /api/v1/documents/:id/highlights |
| GET | /api/v1/documents/:id/highlights/me |
| PATCH | /api/v1/highlights/:id |
| DELETE | /api/v1/highlights/:id |
| GET | /api/v1/highlights/me |
| GET | /api/v1/highlights/palette |
| PATCH | /api/v1/highlights/palette |
| POST | /api/v1/journals |
| GET | /api/v1/journals |
| GET | /api/v1/journals/:id |
| PATCH | /api/v1/journals/:id |
| DELETE | /api/v1/journals/:id |
| POST | /api/v1/journals/:id/highlights |
| DELETE | /api/v1/journals/:id/highlights/:highlightId |
| PATCH | /api/v1/journals/:id/highlights/reorder |

### Follows & Social Feed

| Method | Endpoint |
|--------|----------|
| POST | /api/v1/profiles/:username/follow |
| DELETE | /api/v1/profiles/:username/follow |
| GET | /api/v1/profiles/:username/followers |
| GET | /api/v1/profiles/:username/following |
| GET | /api/v1/feed/following |
| GET | /api/v1/follows/requests |
| POST | /api/v1/follows/requests/:id/accept |
| DELETE | /api/v1/follows/requests/:id/reject |

### Profile documents

| Method | Endpoint |
|--------|----------|
| GET | /api/v1/profiles/:username/documents |

### Style Templates

| Method | Endpoint |
|--------|----------|
| POST | /api/v1/document-style-templates |
| GET | /api/v1/document-style-templates |
| DELETE | /api/v1/document-style-templates/:id |

### Tests to pass before v1.0 release

- books.service tests ✓
- highlights.service tests ✓
- journals.service tests ✓
- follows.service tests ✓

### Security gates

- Fix all LOW findings from `docs/SECURITY.md`
- See `docs/SECURITY_REMEDIATION.md` for details

---

## Future (post v1.0)

Features planned but not yet implemented:

- Comments on documents
- Sharevault (public workspace layer with PIN protection)
- Team workspaces
- Email verification & password reset
- Account feature (change email/password/username)
- Contract signatures (document_signatures)
- Blockchain migration for signatures (tx_hash — Solana or Base)
- Full-text search (PostgreSQL tsvector)
- Notifications system
- Admin panel (beyond category management)
- Analytics & reading stats
- RSS feeds
- API rate limiting per user tier
- Monetization & plans
