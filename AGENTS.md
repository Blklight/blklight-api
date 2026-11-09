# blklight-fastify-api

REST API built with Fastify, auth-first, growing into full CRUD capabilities.

## Current Status

Baseline atual: 196 testes / 0 failed, `tsc` sem erros; suíte de autorização entre contas em `tests/integration/authorization.test.ts`. Último trabalho: itens
P e M de `docs/QUALITY_REPORT.md` (sandbox em QuickJS num worker, OAuth com
state/PKCE e vínculo por intenção de uso único, dependências sem
vulnerabilidades altas, `TRUST_PROXY`, rate limits por usuário, migrations 0024
de `follows` e 0025 de índices). Future: comments (post-MVP).

> Inventário completo de rotas (admin, auth, pública) em `ADMIN_ROUTES.md` (não commitável).

## Migration Process

- **Only `drizzle-kit generate` may produce schema changes.** Hand-written `.sql`
  is forbidden as the standard practice. Run `npm run db:generate`, which writes a
  journaled migration + snapshot under `drizzle/migrations/`.
- **Phase/PR checklist when a change touches `src/**/*.schema.ts`:**
  1. `npm run db:generate` — produces `NNNN_*.sql` + snapshot + journal entry.
  2. `npm run db:migrate` on the dev DB — verify it applies cleanly.
  3. Commit the `drizzle/` artifacts (SQL + snapshot + `_journal.json`).
  4. Confirm the new `_snapshot.json` exists alongside the `.sql`.
  5. `npm run db:migrate` again — confirm zero pending.
  6. `npm run db:migrations:check` — confirm "No drift" (schema.ts ↔ latest snapshot).
- **Manual migrations are a documented exception only.** If a hand-written SQL
  migration is ever unavoidable, it must: live under `drizzle/migrations/manual/`,
  stay OUT of `_journal.json` (so `db:migrate` never auto-runs it), be applied
  manually, and be recorded explicitly in this file's history table below — never
  silent. This rule covers SQL that does **not** accompany a schema change (data
  cleanup, backfills that cannot be expressed in `schema.ts`).
- **Generated migrations MAY be hand-edited when they need a data backfill in the
  same step.** `drizzle-kit generate` cannot express a data backfill, so a column
  that must be backfilled before a NOT NULL / type change cannot be generated
  correctly. In that case the generated file is kept in `_journal.json`, is applied
  by `npm run db:migrate`, and the hand-added statements must be documented in the
  file header. Precedents: `0020_flashy_odin` and `0022_eminent_mattie_franklin`.
- **snapshot ↔ schema anti-drift check:** `npm run db:migrations:check`
  (`src/db/migrations-check.ts`) regenerates the snapshot from `schema.ts` via
  `drizzle-kit` and deep-compares against the latest journal snapshot, without
  touching the database. Exit 0 = no drift, exit 1 = drift (run `db:generate`).
- **New environment provisioning:** a fresh DB only needs `npm run db:migrate`.
  0015–0018 were folded into the formal state by 0019, so they must NOT be applied
  separately anymore — `0019` covers the same DDL.

### Historical manual migrations 0015–0018 (formalized retroactively by 0019)

These are the historical hand-written series from the `user_id` → `profile_id`
refactor. They were applied manually via psql, are tracked in git as documentation,
and were retroactively formalized into the journal by `0019_baseline_profile_id_migration`
(Build 2) — which aggregates their combined DDL and is registered as applied without
execution. They no longer need manual application on new environments.

| Migration | Applied on | State |
| --------- | ---------- | ----- |
| 0015_migrate_likes_bookmarks_to_profile_id | 2026-09-01 | manual, folded into 0019 |
| 0016_migrate_highlights_books_to_profile_id | 2026-08-19 | manual, folded into 0019 |
| 0017_migrate_exercise_submissions_and_user_apps_to_profile_id | 2026-08-20 | manual, folded into 0019 |
| 0018_platform_apps_expansion_and_app_invites | 2026-08-21 | manual, folded into 0019 |

Note: `0015` hardcodes the old unique-constraint names as `..._user_id_document_id_key`,
but the dev DB had created them as `..._user_id_document_id_unique`. The manual
application used the actual constraint names present in the DB. See
`docs/MIGRATION_0015_0018_GITIGNORE_REPORT.md` for the full naming-divergence details.

### 0020 — embeddings to native pgvector (generated + hand-added backfill)

`0020_flashy_odin.sql` was produced by `drizzle-kit generate` (`embeddings.embedding`
text → `vector(768)`, plus the HNSW cosine index) and then hand-edited to insert a
data backfill statement BEFORE the type change: the old JSON-array text is cast
through `jsonb` (validation) and stripped of whitespace, then the column is altered
with an explicit `USING "embedding"::vector`. Unlike 0015–0018, this migration stays
IN `_journal.json` and is applied by `db:migrate` — the hand-added statement is
documented in the SQL header. Applied on the dev DB 2026-09-16 with 0 data drift.

### 0022 — session rotation families (generated + hand-added backfill)

`0022_eminent_mattie_franklin.sql` was produced by `drizzle-kit generate`
(`sessions.family_id` / `rotated_at` / `remember_me`, plus the `user_id` and
`family_id` indexes) and then hand-edited in the same pattern as 0020: the column is
added NULLABLE, every existing row is backfilled with `family_id = id` so each legacy
session becomes its own single-token family, and only then is NOT NULL applied. The
generator emits `ADD COLUMN "family_id" text NOT NULL` with no default, which aborts
on any table that already has rows. Stays IN `_journal.json`, applied by `db:migrate`.

Verified 2026-10-02: the 63 sessions that existed on the dev DB were preserved, all
63 with `family_id = id` and zero NULLs, and the file also applies cleanly to a
database created from zero with `db:migrate` alone.

### manual/0001 — invalidate legacy plaintext refresh tokens (manual, not journaled)

`drizzle/migrations/manual/0001_invalidate_legacy_plaintext_refresh_tokens.sql` runs a
single `DELETE FROM "sessions"`. It accompanies no schema change, so per the rule
above it lives in `manual/`, stays out of `_journal.json`, and is applied manually.

Why it is required: `sessions.refresh_token` now stores a SHA-256 digest. The
plaintext of a legacy row never existed in the database, so there is no digest to
backfill — the rows cannot be salvaged and their users must log in again once. This
is also the security-correct outcome, since tokens that were stored in the clear are
compromised by definition. Applied on the dev DB 2026-10-02 against 63 rows.

### Known pre-existing issue — 0011/0015/0019 constraint names vs a fresh DB

A database created from zero fails partway through `0019` with
`constraint "user_apps_user_id_app_id_unique" of relation "user_apps" does not exist`,
and `0015` fails the same way for the other refactored tables. The cause is that
`0011` created `UNIQUE ("user_id", "app_id")` unnamed, so Postgres named it
`..._key`, while the hand-written 0015–0019 series drops `..._unique`. This only
surfaces on a fresh provisioning run; the dev DB was migrated by hand with the real
constraint names, so it never hit this. **Not fixed** — out of scope for the session
rotation work. Fix it by making the 0011 DDL name its constraints explicitly (or by
softening those `DROP CONSTRAINT` statements to `IF EXISTS`).

## Tech Stack

- **Runtime**: Node.js 20+
- **Framework**: Fastify v5 with TypeScript (CommonJS)
- **Validation**: Zod v4, single source for request input. In a route, declare `body`/`querystring`/`params` as `toJsonSchema(xSchema)` (`src/utils/json-schema.ts`, used by Fastify and `/docs`) and call `xSchema.parse(request.body)` in the handler; a `ZodError` reaches `setErrorHandler`, which answers the 400 `VALIDATION_ERROR` envelope. Never hand-write the input JSON Schema or the 400 response.
- **Database**: PostgreSQL with Drizzle ORM (postgres-js driver)
- **Auth**: JWT with access + refresh tokens, httpOnly cookies
- **Password Hashing**: node:crypto (pbkdf2Sync)
- **IDs**: CUID2
- **API Docs**: @fastify/swagger + @scalar/fastify-api-reference
- **Realtime**: @fastify/websocket (chat channel subscriptions)
- **Email**: Resend with persistent queue + React Email
- **Embeddings**: Google Gemini text-embedding-004 (via REST, no SDK)
- **Vector search**: pgvector extension on PostgreSQL

## Folder Structure

```
docker-compose.yml    - PostgreSQL container configuration
src/
  http/
    server.ts       - Entry point: listen + graceful shutdown
  features/
    auth/
      auth.routes.ts - Auth route handlers (register, login, refresh, logout)
      auth.service.ts - Auth business logic
      auth.schema.ts - Drizzle schema: users + sessions tables
      auth.zod.ts    - Zod validation schemas
    profiles/
      profiles.routes.ts - Profile route handlers
      profiles.service.ts - Profile business logic
      profiles.schema.ts - Drizzle schema: profiles table
      profiles.zod.ts    - Zod validation schemas
    signatures/
      signatures.schema.ts - Drizzle schema: signatures table
      signatures.service.ts - Document signing/verification service
    documents/
      documents.routes.ts - Document route handlers
      documents.service.ts - Document business logic
      documents.schema.ts - Drizzle schema: documents, document_styles, document_types
      documents.zod.ts - Zod validation schemas
    document-style-templates/
      document-style-templates.routes.ts
      document-style-templates.service.ts
      document-style-templates.schema.ts - Drizzle schema: document_style_templates
      document-style-templates.zod.ts
    tutorial-exercises/
      tutorial-exercises.routes.ts
      tutorial-exercises.service.ts
      tutorial-exercises.schema.ts - Drizzle schema: tutorial_exercises, exercise_submissions
      tutorial-exercises.zod.ts
    likes/
      likes.routes.ts
      likes.service.ts
      likes.schema.ts - Drizzle schema: document_likes
    bookmarks/
      bookmarks.routes.ts
      bookmarks.service.ts
      bookmarks.schema.ts - Drizzle schema: document_bookmarks
    categories/
      categories.routes.ts - Category route handlers (public + admin)
      categories.service.ts
      categories.schema.ts - Drizzle schema: categories, document_categories
    tags/
      tags.routes.ts - Tag route handlers (public)
      tags.service.ts
      tags.schema.ts - Drizzle schema: tags, document_tags
    books/
      books.routes.ts
      books.service.ts
      books.schema.ts - Drizzle schema: books, book_chapters, book_category, book_tags, book_progress, book_chapter_progress
      books.zod.ts
    highlights/
      highlights.routes.ts
      highlights.service.ts
      highlights.schema.ts - Drizzle schema: highlights, highlight_palette
      highlights.zod.ts
    workspace/
      workspace.routes.ts
      workspace.service.ts
      workspace.schema.ts - Drizzle schema: workspaces, workspace_members
      workspace.zod.ts
    canvas/
      canvas.routes.ts - Canvas route handlers
      canvas.service.ts - Canvas business logic
      canvas.schema.ts - Drizzle schema: canvas, canvas_positions
      canvas.zod.ts
    notes/
      notes.routes.ts
      notes.service.ts
      notes.schema.ts - Drizzle schema: notes (now references canvas_id)
      notes.zod.ts
    journals/
      journals.routes.ts
      journals.service.ts
      journals.schema.ts - Drizzle schema: journals, journal_highlights
      journals.zod.ts
    follows/
      follows.routes.ts
      follows.service.ts
      follows.schema.ts - Drizzle schema: follows
    platform-apps/
      platform-apps.routes.ts - App catalog + user app activation
      platform-apps.service.ts
      platform-apps.schema.ts - Drizzle schema: platform_apps, user_apps
      platform-apps.zod.ts
    organizations/
      organizations.routes.ts - Org management + public document listing
      organizations.service.ts - Org/membership logic + mapOrganization()
      organizations.schema.ts - Drizzle schema: organizations, organization_members
      organizations.zod.ts
    memory/
      memory.routes.ts - Semantic search + related + digest
      memory.service.ts - Embedding generation + similarity search
      memory.schema.ts - Drizzle schema: embeddings
      memory.zod.ts
      memory.job.ts - Background indexing job (fire-and-forget)
    email/
      email.service.ts - Email queue management + send logic
      email.queue.ts - Queue processor (setInterval)
      email.schema.ts - Drizzle schema: email_verifications, password_resets, email_queue
      email.templates/
        verification.tsx
        welcome.tsx
        password-reset.tsx
        memory-digest.tsx - Weekly semantic connections digest
        index.ts - Exports compiled HTML functions
    chat/
      chat.routes.ts - Chat REST routes + WS ticket/endpoint
      chat.service.ts - Chat business logic + WS broadcasts
      chat.schema.ts - Drizzle schema: chat_servers, chat_server_members, chat_channels, chat_messages
      chat.zod.ts
      ws-tickets.ts - Single-use WS connection tickets (TTL 30s)
      ws-registry.ts - In-memory channel subscriptions + broadcast
  db/
    index.ts        - Drizzle client singleton
    migrate.ts      - Migration runner script
    migrations-check.ts - schema.ts ↔ latest snapshot anti-drift check
    seed.ts         - Database seeder (categories, tags, platform_apps)
  utils/
    crypto.ts       - Password hashing + document signing utilities
    errors.ts       - Custom error classes
    sandbox.ts      - Code execution sandbox (QuickJS in a worker thread)
    cursor.ts       - Cursor encoding/decoding for pagination
    toc.ts          - Table of contents extraction from TipTap JSON
  hooks/
    admin-guard.ts  - requireAdmin preHandler for admin-only routes
  config/
    env.ts          - Environment variable validation with Zod
    features.ts     - Feature flags configuration
    highlight-palette.ts - Default highlight color palette (5 colors)
    note-colors.ts  - Valid Tailwind color names for notes
  app.ts            - Fastify instance: plugins, hooks, error handler
tests/
  utils/           - Unit tests for utility functions
  services/        - Unit tests for service functions (mocked DB)
vitest.config.ts   - Vitest test configuration
types/
  api.types.ts     - Complete TypeScript types for frontend
  form.schemas.ts  - Zod validation schemas for frontend forms
docs/
  SECURITY.md
  SECURITY_REMEDIATION.md
  SECURITY_SESSIONS.md
```

## Code Style

- All code and comments in English
- async/await only — never .then()/.catch() chains
- Early returns — avoid nested if/else
- Named functions at module level; arrow functions for callbacks/inline
- camelCase for variables/functions, PascalCase for types/interfaces
- `interface` for domain objects, `type` for unions and utilities
- Never use `any` — use `unknown` when type is uncertain
- Use `z.infer<typeof Schema>` to derive types from Zod schemas
- Always explicitly type service function return types
- Comment the WHY not the WHAT
- JSDoc on all exported service functions (@param, @returns, @throws)
- DB tables: snake_case — TypeScript variables: camelCase

## Database Schema

### users (identity — private)

| Column              | Type      | Notes                     |
| ------------------- | --------- | ------------------------- |
| id                  | text      | CUID2, primary key        |
| email               | text      | unique, not null          |
| username            | text      | unique, not null          |
| password_hash       | text      | nullable (null for OAuth) |
| salt                | text      | nullable                  |
| email_verified      | boolean   | default false             |
| role                | text      | 'user' or 'admin'         |
| github_id           | text      | unique, nullable          |
| google_id           | text      | unique, nullable          |
| onboarding_complete | boolean   | default false             |
| deleted_at          | timestamp | nullable (soft delete)    |
| created_at          | timestamp | default now()             |
| updated_at          | timestamp | default now()             |

### sessions

| Column        | Type      | Notes                                            |
| ------------- | --------- | ------------------------------------------------ |
| id            | text      | CUID2, primary key                               |
| user_id       | text      | foreign key → users.id                           |
| refresh_token | text      | unique, not null — **SHA-256 digest**, not the token |
| family_id     | text      | not null — shared by every token in a rotation chain |
| rotated_at    | timestamp | nullable — set when this token is superseded     |
| remember_me   | boolean   | default false — persisted so rotations keep the TTL |
| expires_at    | timestamp | not null                                         |
| created_at    | timestamp | default now()                                    |

Indexes: `sessions_user_id_idx`, `sessions_family_id_idx`.

### email_verifications

| Column     | Type      | Notes                          |
| ---------- | --------- | ------------------------------ |
| id         | text      | CUID2, primary key             |
| user_id    | text      | unique, foreign key → users.id |
| token      | text      | unique, not null               |
| expires_at | timestamp | not null                       |
| created_at | timestamp | default now()                  |

### password_resets

| Column     | Type      | Notes                  |
| ---------- | --------- | ---------------------- |
| id         | text      | CUID2, primary key     |
| user_id    | text      | foreign key → users.id |
| token      | text      | unique, not null       |
| expires_at | timestamp | not null               |
| used_at    | timestamp | nullable               |
| created_at | timestamp | default now()          |

### email_queue

| Column       | Type      | Notes                           |
| ------------ | --------- | ------------------------------- |
| id           | text      | CUID2, primary key              |
| to           | text      | not null                        |
| subject      | text      | not null                        |
| html         | text      | not null                        |
| status       | text      | 'pending' \| 'sent' \| 'failed' |
| attempts     | integer   | default 0                       |
| last_error   | text      | nullable                        |
| scheduled_at | timestamp | default now()                   |
| sent_at      | timestamp | nullable                        |
| created_at   | timestamp | default now()                   |

### profiles (public — one-to-one with users)

| Column       | Type      | Notes                          |
| ------------ | --------- | ------------------------------ |
| id           | text      | CUID2, primary key             |
| user_id      | text      | unique, foreign key → users.id |
| username     | text      | unique, mirrored from users    |
| display_name | text      | nullable                       |
| bio          | text      | nullable                       |
| bio_private  | text      | nullable                       |
| avatar_url   | text      | nullable                       |
| social_links | jsonb     | nullable                       |
| is_private   | boolean   | default false                  |
| deleted_at   | timestamp | nullable (soft delete)         |
| created_at   | timestamp | default now()                  |
| updated_at   | timestamp | default now()                  |

### signatures (authorship identity)

| Column           | Type      | Notes                                       |
| ---------------- | --------- | ------------------------------------------- |
| id               | text      | CUID2, primary key                          |
| user_id          | text      | unique, foreign key → users.id              |
| user_hash        | text      | unique, public authorship identity          |
| secret_encrypted | text      | AES-256-GCM encrypted per-user secret       |
| tx_hash          | text      | nullable, reserved for blockchain migration |
| created_at       | timestamp | default now()                               |

### platform_apps (app catalog — seeded)

| Column      | Type      | Notes                                                           |
| ----------- | --------- | --------------------------------------------------------------- |
| id          | text      | CUID2, primary key                                              |
| slug        | text      | unique, not null ('canvas', 'publisher', 'reader', 'dev-tools') |
| name        | text      | not null                                                        |
| description | text      | nullable                                                        |
| is_active   | boolean   | default true (global kill switch)                               |
| created_at  | timestamp | default now()                                                   |

### user_apps (apps activated per user)

| Column       | Type      | Notes                          |
| ------------ | --------- | ------------------------------ |
| id           | text      | CUID2, primary key             |
| user_id      | text      | foreign key → users.id         |
| app_id       | text      | foreign key → platform_apps.id |
| activated_at | timestamp | default now()                  |

Unique constraint: (user_id, app_id)

### workspaces

| Column       | Type      | Notes                          |
| ------------ | --------- | ------------------------------ |
| id           | text      | CUID2, primary key             |
| owner_id     | text      | unique, foreign key → users.id |
| type         | text      | 'personal' \| 'team'           |
| name         | text      | not null                       |
| is_personal  | boolean   | default true                   |
| color_labels | jsonb     | nullable                       |
| created_at   | timestamp | default now()                  |
| updated_at   | timestamp | default now()                  |

### workspace_members

| Column       | Type      | Notes                          |
| ------------ | --------- | ------------------------------ |
| id           | text      | CUID2, primary key             |
| workspace_id | text      | foreign key → workspaces.id    |
| user_id      | text      | foreign key → users.id         |
| role         | text      | 'owner' \| 'admin' \| 'member' |
| created_at   | timestamp | default now()                  |

Unique constraint: (workspace_id, user_id)

### canvas (one-to-one with workspace)

| Column       | Type      | Notes                               |
| ------------ | --------- | ----------------------------------- |
| id           | text      | CUID2, primary key                  |
| workspace_id | text      | unique, foreign key → workspaces.id |
| created_at   | timestamp | default now()                       |
| updated_at   | timestamp | default now()                       |

### canvas_positions (spatial layout of notes on canvas)

| Column     | Type      | Notes                          |
| ---------- | --------- | ------------------------------ |
| id         | text      | CUID2, primary key             |
| canvas_id  | text      | foreign key → canvas.id        |
| note_id    | text      | unique, foreign key → notes.id |
| x          | real      | horizontal position            |
| y          | real      | vertical position              |
| w          | real      | width (default 200)            |
| h          | real      | height (default 150)           |
| z          | integer   | stack order (default 0)        |
| updated_at | timestamp | default now()                  |

Unique constraint: (canvas_id, note_id)

### notes (post-its — belong to canvas)

| Column     | Type      | Notes                                  |
| ---------- | --------- | -------------------------------------- |
| id         | text      | CUID2, primary key                     |
| canvas_id  | text      | foreign key → canvas.id                |
| title      | text      | nullable                               |
| content    | text      | markdown string                        |
| type       | text      | 'text' \| 'code' \| 'list'             |
| language   | text      | nullable (required when type = 'code') |
| color      | text      | Tailwind color name, default 'yellow'  |
| deleted_at | timestamp | nullable (soft delete)                 |
| created_at | timestamp | default now()                          |
| updated_at | timestamp | default now()                          |

Note: `canvas_id` replaces the former `workspace_id`. Canvas is the spatial
container for notes. Workspace is the owner of canvas. Notes never reference
workspace directly.

### embeddings (semantic memory — transversal)

| Column      | Type        | Notes                                                         |
| ----------- | ----------- | ------------------------------------------------------------- |
| id          | text        | CUID2, primary key                                            |
| user_id     | text        | foreign key → users.id                                        |
| source_type | text        | 'note' \| 'document' \| 'journal_highlight' \| 'book_chapter' |
| source_id   | text        | ID of the indexed entity in its own table                     |
| embedding   | vector(768) | pgvector column — requires CREATE EXTENSION vector            |
| indexed_at  | timestamp   | default now()                                                 |
| created_at  | timestamp   | default now()                                                 |

Unique constraint: (user_id, source_type, source_id)

Requires: `CREATE EXTENSION IF NOT EXISTS vector;` before running migrations.

### document_types (seeded on migration)

| Column     | Type      | Notes                                               |
| ---------- | --------- | --------------------------------------------------- |
| id         | text      | CUID2, primary key                                  |
| name       | text      | unique (article, tutorial, contract, project, page) |
| created_at | timestamp | default now()                                       |

### documents

| Column          | Type      | Notes                                |
| --------------- | --------- | ------------------------------------ |
| id              | text      | CUID2, primary key                   |
| author_id       | text      | foreign key → profiles.id            |
| type_id         | text      | foreign key → document_types.id      |
| status          | text      | 'draft' \| 'published' \| 'archived' |
| title           | text      | not null                             |
| abstract        | text      | nullable                             |
| content         | jsonb     | nullable (TipTap JSON)               |
| cover_image_url | text      | nullable                             |
| slug            | text      | unique per author (author_id + slug) |
| organization_id | text      | nullable, foreign key → organizations.id (ON DELETE SET NULL) |
| authorship      | jsonb     | set on publish, null while draft     |
| published_at    | timestamp | nullable                             |
| deleted_at      | timestamp | nullable (soft delete)               |
| created_at      | timestamp | default now()                        |
| updated_at      | timestamp | default now()                        |

### document_styles

| Column             | Type      | Notes                              |
| ------------------ | --------- | ---------------------------------- |
| id                 | text      | CUID2, primary key                 |
| document_id        | text      | unique, foreign key → documents.id |
| typography         | text      | 'sans' \| 'serif' \| 'mono'        |
| paper_style        | jsonb     | nullable                           |
| paper_texture      | jsonb     | nullable                           |
| cover_settings     | jsonb     | nullable                           |
| document_header    | jsonb     | nullable                           |
| document_footer    | jsonb     | nullable                           |
| document_signature | jsonb     | nullable                           |
| updated_at         | timestamp | default now()                      |

### document_style_templates

| Column          | Type      | Notes                       |
| --------------- | --------- | --------------------------- |
| id              | text      | CUID2, primary key          |
| author_id       | text      | foreign key → profiles.id   |
| name            | text      | not null, max 50            |
| document_type   | text      | nullable                    |
| typography      | text      | 'sans' \| 'serif' \| 'mono' |
| paper_style     | jsonb     | nullable                    |
| paper_texture   | jsonb     | nullable                    |
| document_header | jsonb     | nullable                    |
| document_footer | jsonb     | nullable                    |
| created_at      | timestamp | default now()               |

### tutorial_exercises

| Column      | Type      | Notes                                |
| ----------- | --------- | ------------------------------------ |
| id          | text      | CUID2, primary key                   |
| document_id | text      | foreign key → documents.id           |
| type        | text      | 'code' \| 'quiz'                     |
| data        | jsonb     | exercise data (shape varies by type) |
| created_at  | timestamp | default now()                        |
| updated_at  | timestamp | default now()                        |

### exercise_submissions

| Column      | Type      | Notes                               |
| ----------- | --------- | ----------------------------------- |
| id          | text      | CUID2, primary key                  |
| user_id     | text      | foreign key → users.id              |
| exercise_id | text      | foreign key → tutorial_exercises.id |
| attempts    | jsonb     | array of attempt objects            |
| created_at  | timestamp | default now()                       |
| updated_at  | timestamp | default now()                       |

Unique constraint: (user_id, exercise_id)

### document_likes

| Column      | Type      | Notes                      |
| ----------- | --------- | -------------------------- |
| id          | text      | CUID2, primary key         |
| user_id     | text      | foreign key → users.id     |
| document_id | text      | foreign key → documents.id |
| created_at  | timestamp | default now()              |

Unique constraint: (user_id, document_id)

### document_bookmarks

| Column      | Type      | Notes                      |
| ----------- | --------- | -------------------------- |
| id          | text      | CUID2, primary key         |
| user_id     | text      | foreign key → users.id     |
| document_id | text      | foreign key → documents.id |
| created_at  | timestamp | default now()              |

Unique constraint: (user_id, document_id)

### categories

| Column      | Type      | Notes                      |
| ----------- | --------- | -------------------------- |
| id          | text      | CUID2, primary key         |
| name        | text      | not null                   |
| slug        | text      | unique, not null           |
| description | text      | nullable                   |
| parent_id   | text      | self-referential, nullable |
| created_at  | timestamp | default now()              |

### tags

| Column     | Type      | Notes                                      |
| ---------- | --------- | ------------------------------------------ |
| id         | text      | CUID2, primary key                         |
| name       | text      | unique, not null (normalized to lowercase) |
| slug       | text      | unique, not null                           |
| created_at | timestamp | default now()                              |

### document_categories

| Column      | Type      | Notes                              |
| ----------- | --------- | ---------------------------------- |
| id          | text      | CUID2, primary key                 |
| document_id | text      | foreign key → documents.id, unique |
| category_id | text      | foreign key → categories.id        |
| created_at  | timestamp | default now()                      |

### document_tags

| Column      | Type      | Notes                      |
| ----------- | --------- | -------------------------- |
| id          | text      | CUID2, primary key         |
| document_id | text      | foreign key → documents.id |
| tag_id      | text      | foreign key → tags.id      |
| created_at  | timestamp | default now()              |

Unique constraint: (document_id, tag_id)

### books

| Column          | Type      | Notes                                      |
| --------------- | --------- | ------------------------------------------ |
| id              | text      | CUID2, primary key                         |
| author_id       | text      | foreign key → profiles.id                  |
| status          | text      | 'draft' \| 'published'                     |
| title           | text      | not null                                   |
| description     | text      | nullable                                   |
| cover_image_url | text      | nullable                                   |
| slug            | text      | unique per author (author_id + slug)       |
| toc             | jsonb     | auto-generated but editable, null on draft |
| authorship      | jsonb     | set on publish                             |
| deleted_at      | timestamp | nullable (soft delete)                     |
| created_at      | timestamp | default now()                              |
| updated_at      | timestamp | default now()                              |

### book_chapters

| Column      | Type      | Notes                      |
| ----------- | --------- | -------------------------- |
| id          | text      | CUID2, primary key         |
| book_id     | text      | foreign key → books.id     |
| document_id | text      | foreign key → documents.id |
| position    | integer   | order within the book      |
| intro_text  | text      | nullable                   |
| outro_text  | text      | nullable                   |
| created_at  | timestamp | default now()              |
| updated_at  | timestamp | default now()              |

Unique constraint: (book_id, document_id)
Unique constraint: (book_id, position)

### book_category

| Column      | Type | Notes                               |
| ----------- | ---- | ----------------------------------- |
| book_id     | text | primary key, foreign key → books.id |
| category_id | text | foreign key → categories.id         |

### book_tags

| Column  | Type | Notes                  |
| ------- | ---- | ---------------------- |
| book_id | text | foreign key → books.id |
| tag_id  | text | foreign key → tags.id  |

Unique constraint: (book_id, tag_id)

### book_progress

| Column          | Type      | Notes                          |
| --------------- | --------- | ------------------------------ |
| id              | text      | CUID2, primary key             |
| user_id         | text      | foreign key → users.id         |
| book_id         | text      | foreign key → books.id         |
| last_chapter_id | text      | foreign key → book_chapters.id |
| created_at      | timestamp | default now()                  |
| updated_at      | timestamp | default now()                  |

Unique constraint: (user_id, book_id)

### book_chapter_progress

| Column     | Type      | Notes                          |
| ---------- | --------- | ------------------------------ |
| id         | text      | CUID2, primary key             |
| user_id    | text      | foreign key → users.id         |
| chapter_id | text      | foreign key → book_chapters.id |
| is_read    | boolean   | default false                  |
| read_at    | timestamp | nullable                       |

Unique constraint: (user_id, chapter_id)

### highlights

| Column      | Type      | Notes                                        |
| ----------- | --------- | -------------------------------------------- |
| id          | text      | CUID2, primary key                           |
| user_id     | text      | foreign key → users.id                       |
| document_id | text      | foreign key → documents.id                   |
| text        | text      | highlighted text content                     |
| color       | text      | color from user palette                      |
| position    | jsonb     | JSONB: { nodeIndex, offsetStart, offsetEnd } |
| created_at  | timestamp | default now()                                |
| updated_at  | timestamp | default now()                                |

### highlight_palette

| Column     | Type      | Notes                              |
| ---------- | --------- | ---------------------------------- |
| id         | text      | CUID2, primary key                 |
| user_id    | text      | unique, foreign key → users.id     |
| colors     | jsonb     | array of hex color strings (max 5) |
| updated_at | timestamp | default now()                      |

### journals

| Column       | Type      | Notes                                 |
| ------------ | --------- | ------------------------------------- |
| id           | text      | CUID2, primary key                    |
| workspace_id | text      | foreign key → workspaces.id           |
| title        | text      | not null, max 200                     |
| description  | text      | nullable, max 500                     |
| color        | text      | default 'indigo', must be NOTE_COLORS |
| deleted_at   | timestamp | nullable (soft delete)                |
| created_at   | timestamp | default now()                         |
| updated_at   | timestamp | default now()                         |

### journal_highlights

| Column       | Type      | Notes                       |
| ------------ | --------- | --------------------------- |
| id           | text      | CUID2, primary key          |
| journal_id   | text      | foreign key → journals.id   |
| highlight_id | text      | foreign key → highlights.id |
| position     | integer   | order within the journal    |
| created_at   | timestamp | default now()               |

Unique constraint: (journal_id, highlight_id)
Unique constraint: (journal_id, position)

### follows

| Column       | Type      | Notes                                 |
| ------------ | --------- | ------------------------------------- |
| id           | text      | CUID2, primary key                    |
| follower_id  | text      | foreign key → profiles.id             |
| following_id | text      | foreign key → profiles.id             |
| status       | text      | 'pending' \| 'accepted' \| 'rejected' |
| created_at   | timestamp | default now()                         |
| updated_at   | timestamp | default now()                         |

Unique constraint: (follower_id, following_id)

## Available Scripts

| Script                  | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `npm run dev`           | Start dev server with hot reload (tsx watch)    |
| `npm run build`         | Compile TypeScript to JavaScript                |
| `npm run start`         | Run production server from dist/                |
| `npm run db:generate`   | Generate Drizzle migrations                     |
| `npm run db:migrate`    | Run pending migrations                          |
| `npm run db:seed`       | Seed database (categories, tags, platform_apps) |
| `npm run db:studio`     | Open Drizzle Studio                             |
| `npm run db:migrations:check` | Check schema.ts vs latest snapshot drift   |
| `npm test`              | Run all tests                                   |
| `npm run test:watch`    | Run tests in watch mode                         |
| `npm run test:coverage` | Run tests with coverage                         |

### Test baseline

`npm test` is **136 passed / 0 failed** (14 files). Treat that count as the
baseline: a change is only a regression if it makes a previously passing test fail.
`npx tsc --noEmit` still has 2 pre-existing `TS2769` errors in `src/app.ts`
(lines 108 and 121), also unrelated and left as-is.

`tests/services/session-rotation.test.ts` is the only test that talks to a real
database. It mocks `src/config/env` and points `DATABASE_URL` at the dev DB, then
creates and deletes its own users, so it is not runnable without Postgres up.

## How to Run Locally

> **Note:** Docker must be running before starting the server.

```bash
cp .env.example .env.development
docker compose up -d
npm install
npm run db:generate
npm run db:migrate
npm run dev
```

Server runs at http://localhost:3000
API docs at http://localhost:3000/docs

## Architectural Decisions

- **NEVER** import `process.env` directly — always use `src/config/env.ts`
- **NEVER** use external hashing libs — use `node:crypto` only
- **ALWAYS** validate inputs with Zod before the service layer
- **ALWAYS** use CUID2 for new IDs
- **ALWAYS** create users and profiles in the same DB transaction
- **ONLY** store refresh tokens in httpOnly cookies, never in response body
- **ALL** responses must follow `{ data, error, message }` standard
- **NEVER** store raw secrets — always encrypt with AES-256-GCM before saving
- **NEVER** expose secret_encrypted, user_hash raw, or tx_hash in API responses
- **signDocument() and verifyDocument()** are the only entry points for article signing
- **tx_hash** field is nullable and reserved for future blockchain migration
- **Signatures remain accessible after account deletion** — they are permanent proof of authorship
- **author_id in documents always references profiles.id** — never users.id
- **documents and document_styles always created in the same transaction**
- **Category and tags are part of the same transaction as the document write** — an unknown categoryId answers 404 and rolls the whole write back, leaving no document and no style row behind
- **setDocumentCategory / setDocumentTags / upsertTags / removeDocumentCategory accept an optional tx** — they join the caller's transaction instead of opening one of their own
- **slug is unique per author** — composite unique constraint on (author_id, slug)
- **authorship jsonb only set on publish** — null while draft
- **authorship.hmac enables cryptographic verification** via verifyDocument() from signatures.service.ts
- **publishDocument() resolves profiles.id → users.id internally** before calling signDocument()
- **Content edits on published documents do NOT reset authorship/status/publishedAt** — authorship is immutable metadata of "who published what, when"; its integrity is not actively verified (verifyDocument has no runtime call sites), so it may become stale vs. post-publish edits; revisit if a public authenticity endpoint is ever added
- **correct_index and expected_output are NEVER returned to readers** — stripped from exercise responses
- **Code exercises run in QuickJS (`quickjs-emscripten`, WASM) inside a worker thread** — 3s timeout (monotonic, also covers promise jobs), 32 MB guest memory, 512 KB stack, 64 KB of captured logs, at most 4 concurrent runs. Pure JavaScript and TypeScript (transpiled via esbuild). Never go back to `node:vm`: it is not an isolation boundary (the host `Function` is reachable through injected objects)
- **SupportedLanguage: 'javascript' | 'typescript'** — extensible for future languages without refactor
- **Login identifier can be email (contains '@') or username** — detected by presence of '@' character
- **exercise_submissions uses upsert** — one row per (user_id, exercise_id)
- **attempts array appended on each submission** — never replaced
- **quiz and code exercises use discriminated union Zod schemas** — discriminated on `type` field
- **Never add language support to sandbox without adding to SupportedLanguage type first**
- **Public routes never require authentication** — response shape is identical for all visitors
- **Cursor encodes { published_at, id } as opaque base64 JSON string** — enables stable pagination
- **DocumentCard never includes content field** — summary only, no full text
- **Deleted users/profiles/documents always excluded from public queries**
- **Tutorial exercises included in full document read** — never in DocumentCard feed responses
- **sort=popular is now active** — orders by likes_count DESC, published_at DESC
- **likes_count always computed via COUNT(\*)** — never stored in documents table
- **liked_by_me is null for unauthenticated requests** — not false
- **Bookmarks are always private** — only owner can see their bookmarks
- **toggleLike and toggleBookmark are idempotent** — safe to call multiple times
- **Tags are globally shared via upsert** — same tag name = same tag record globally
- **Tag names are normalized** — trim + lowercase before storage
- **Maximum 5 tags per document** — enforced in setDocumentTags()
- **setDocumentTags always replaces** — deletes existing then inserts new
- **Category is required on publish** — ValidationError thrown if no category assigned
- **One category per document** — setDocumentCategory replaces existing assignment
- **Categories are hierarchical** — optional parent_id for nested categories
- **Deleted categories reparent children to root** — done in same transaction
- **Public feed supports category and tag filters** — ?category=slug&tag=slug query params
- **DocumentCard and DocumentFull include category and tags** — always fetched on read
- **Books always reference existing published documents** — no content duplication
- **Only the author's own published documents can be chapters** — verified on addChapter()
- **TOC auto-generated on chapter add/remove/reorder** — manually editable via updateToc()
- **Adding/removing chapters requires draft status** — published books cannot be modified
- **Category required on publish for books** — same rule as documents
- **book_progress and book_chapter_progress use upsert** — never duplicated
- **Books feed requires authentication** — unlike documents, books are not public without login
- **document_hash for books = SHA-256({ title, description, author })** — passed to signDocument()
- **Chapter documents include title, abstract, slug in BookFull** — never full content
- **Highlights are always private** — never exposed to other users
- **Color must be from user's active palette** — validated in service layer, not just Zod
- **Default palette is defined in code** — only customizations persisted in DB
- **getDocumentHighlights() returns highlights in reading order** — nodeIndex ASC, offsetStart ASC
- **getMyHighlights() groups by document** — for the highlights dashboard view
- **highlight_palette uses upsert** — one row per user
- **Highlights are independent** — journal relation added in Session 14
- **Every user has exactly one personal workspace** — is_personal = true, created atomically in register transaction
- **Workspace created atomically in register transaction** — users + profiles + signatures + workspaces (4 tables)
- **Canvas created atomically with workspace** — workspace + canvas always exist together (5 tables on register)
- **workspace_members table exists but has no routes** — reserved for future team workspaces
- **Notes belong to canvas via canvas_id** — never directly to workspace or user
- **resolveCanvasId() is the internal bridge** — userId → canvasId for all notes operations (replaces resolveWorkspaceId)
- **canvas_positions is a separate table** — spatial layout is decoupled from note content
- **canvas_positions uses upsert** — one position row per note, updated on move/resize
- **Notes without a canvas_position are valid** — position is optional (list view vs canvas view)
- **color_labels is optional jsonb in workspaces** — keys are NOTE_COLORS, values are free text labels
- **Passing null to updateColorLabels() clears all labels**
- **NOTE_COLORS imported from src/config/note-colors.ts** — never hardcoded
- **language field required when note type is 'code'** — enforced in Zod .refine()
- **Notes are soft-deleted** — deleted_at set, never hard deleted
- **Deleting a note also removes its canvas_position and embedding** — done in same transaction
- **cursor.ts now uses generic timestamp field** — works for any date column
- **Maximum 2 journals per user** — hard limit enforced in createJournal()
- **Journals belong to workspace via workspace_id** — never directly to users
- **Highlights added manually** — never auto-populated
- **Removing a highlight from journal does NOT delete the highlight itself** — only the journal reference
- **journal_highlights rows kept on journal soft delete** — preserves highlight refs if journal is restored
- **Reorder uses transaction** — positions updated atomically
- **Colors use NOTE_COLORS** — for consistency with notes
- **follows reference profiles.id** — never users.id
- **Private profiles hide everything** — only accepted followers see content
- **Follow counts always computed via COUNT(\*)** — never stored in profiles
- **Rejected follow requests are hard deleted** — not kept as 'rejected'
- **getFollowingFeed excludes documents from private profiles**
- **Private authors' documents are hidden from public reads** — visible only to the author and accepted followers, mirroring getPublicProfile
- **getPublicDocument throws NotFoundError for private authors** — same 404 as a missing slug, so a blocked document is indistinguishable from a nonexistent one
- **getPublicFeed filters private authors inside the shared conditions list** — items and total both exclude them, so the count never leaks hidden documents
- **getAuthorPublicDocuments returns an empty result (not 404) for private authors** — the profile itself stays reachable, getPublicProfile redacts it rather than hiding it
- **GET /api/v1/documents and GET /profiles/:username/documents accept optional auth** — same jwtVerify try/catch pattern, needed so accepted followers still see private authors' documents
- **canViewAuthor() is the single in-process privacy check** — non-private author always visible; private author requires viewer === author or follow status 'accepted'
- **buildAuthorVisibilityCondition() mirrors canViewAuthor() in SQL** — an accepted-follow EXISTS subquery, required because the feed count query is separate from the page query
- **GET /profiles/:username accepts optional auth** — for is_following field
- **is_following = null for unauthenticated** — not false
- **follow_status shows pending state** — useful for follow button UI
- **platform_apps are seeded** — never created via API by regular users
- **user_apps uses upsert** — activating an already-active app is a no-op
- **onboarding_complete = true only after both steps are done** — username (OAuth) + app selection
- **activateApps() sets onboarding_complete = true** — the single write point that completes onboarding; called by POST /api/v1/platform-apps/me
- **Email-registered users skip the username step** — onboarding starts at app selection
- **POST /api/v1/auth/onboarding/username is OAuth-only** — rejects email accounts (passwordHash set) and already-complete users
- **POST /api/v1/auth/onboarding/complete is idempotent** — no-op if profile already exists; email accounts already have records from register
- **completeOnboarding() is the shared entry point** — creates profile + signature + workspace + canvas atomically for OAuth; never creates a session by itself (route calls createSessionWithReply)
- **FEATURE_MEMORY flag guards all memory routes and jobs** — if false, notes save normally with no side effects
- **Embedding generation is always fire-and-forget** — never blocks note/document save response
- **memory.job.ts calls Gemini text-embedding-004 via REST** — no SDK dependency
- **embeddings table requires pgvector extension** — run CREATE EXTENSION IF NOT EXISTS vector before migrations
- **Similarity search uses <=> operator** — cosine distance, lower = more similar
- **HNSW index on embeddings.embedding** — required for sub-second search at scale
- **Embedding deleted when source is deleted** — enforced in each feature's delete service function
- **source_type + source_id is the universal pointer** — no FK constraint, resolved at query time
- **Memory digest sent via existing email queue** — same pattern as other transactional emails
- **GEMINI_API_KEY added to env.ts** — required when FEATURE_MEMORY=true
- **buildAuthSession() is the single source of truth** for auth response shape — all auth flows call it
- **AuthSession is the unified response shape** for login, register, refresh, OAuth callbacks, and onboarding status
- **apps field in AuthSession contains activated app slugs** — frontend uses this to gate UI sections
- **apps is always an array** — never null, empty array when no apps activated
- **loginUser() returns only { userId, refreshToken }** — not the raw DB user object
- **Raw DB objects from db.select() are never passed to responses** — always mapped field by field
- **onboarding_complete = false is not a login blocker** — frontend handles redirect via AuthSession
- **GET /api/v1/auth/onboarding/status is read-only** — determines frontend routing step
- **Onboarding step 'username' only applies to OAuth users** pre-username selection
- **Email-registered users go directly to 'apps' step** — never 'username'
- **Explicit Drizzle column selection** used in all queries on sensitive tables — never select() with no args

### Known technical debt — workspace + canvas created on register

- **The fact:** every new account creates a personal workspace + canvas atomically in the
  register transaction — unconditionally, regardless of whether the account ever uses the
  associated features (currently paused in the frontend: canvas, notes, journals).
  Email registration: `auth.service.ts` register transaction (`rs`, workspace/canvas inserts
  at ~424-446). OAuth onboarding: `completeOnboarding()` transaction at ~236-282.
- **Why it exists:** `canvas.workspaceId` is `notNull().unique()` referencing `workspaces.id`
  (`canvas.schema.ts`), so a canvas cannot exist without its workspace. Keeping both created
  in the same register transaction is the simplest shape that satisfies that constraint.
- **Accepted cost:** idle rows in `workspaces`/`canvas` accumulate for accounts that never
  use workspace features. Small footprint per row today; revisit if/before volume becomes a
  concern.
- **When to revisit:** only when a workspace feature is actually un-paused/built in the
  frontend. At that moment, evaluate making workspace + canvas lazy (created on first use)
  instead of at register — and in the same move consider dropping the transactional guarantee
  that a profile always owns a workspace.
- **Where to look when the time comes:** `src/features/auth/auth.service.ts` (the register and
  `completeOnboarding()` transactions) and `src/features/canvas/canvas.schema.ts` (the
  `notNull().unique()` FK). See also the workspace/canvas decision bullets above.

## Chat Realtime (WebSocket)

- **@fastify/websocket** registered in app.ts before all route plugins — required for `websocket: true` routes
- **POST /api/v1/chat/ws-ticket** (auth + rate limit 30/min) returns a single-use ticket (TTL 30s)
- **GET /api/v1/chat/ws?ticket=...&channelId=...** is the WS endpoint — read-only transport
- **Auth happens via ticket, NOT JWT** — tickets stored in-memory in `ws-tickets.ts`, consumed once
- **Close codes**: 4400 missing params, 4401 invalid/expired ticket, 4403 not an accepted member
- **WS registry is in-memory (single instance)** — documented tech debt; future Redis/pub-sub for horizontal scaling
- **Incoming WS messages are ignored** — all writes go through the REST API (single write path)
- **Broadcast events**: `message:new`, `message:updated`, `message:deleted` sent to the channel after the DB write succeeds
- **Broadcast payload shape**: `{ type, channelId, message }` (or `messageId` for delete)
- **Assertions reuse the REST rules** — `assertCanAccessChannel()` reuses `resolveServerFromChannel` + `assertAcceptedMember`
- **broadcastToChannel() never throws** — dead sockets skipped, send errors swallowed so REST flow is never broken

## Refresh Token Rotation

- **sessions.refresh_token stores a SHA-256 digest, never the token** — the plaintext
  only ever exists in the httpOnly cookie and in the `Set-Cookie` response
- **hashRefreshToken() in `src/utils/crypto.ts`** — SHA-256, not PBKDF2, because the
  input is 48 chars of CUID2 entropy and the lookup needs a fast deterministic digest
- **Every read path hashes before comparing** — `refreshSession()` and `logout()`
  hash the cookie value, so the `unique` constraint still holds without a schema change
- **One login = one family** — `family_id` is stable for the whole rotation chain;
  each refresh inserts a new row with the same `family_id`
- **Rotation is mandatory on every refresh** — the consumed row gets `rotated_at`, a
  new token is issued, and `Set-Cookie` is sent only when a rotation happened
- **A replay inside the grace window still returns an access token** — browsers fire
  parallel requests with the same cookie and only the last `Set-Cookie` wins, so
  `rotatedToken = null` tells the route not to overwrite the newer cookie
- **REFRESH_REUSE_GRACE_SECONDS (30s default)** — window in which a replayed token is
  treated as browser noise rather than theft
- **A replay outside the window revokes the whole family** — the newer token of that
  chain also stops working, which is the intended theft-detection outcome
- **refreshSession() reads the row `FOR UPDATE`** — parallel refreshes serialize
  instead of both seeing `rotated_at IS NULL` and both rotating
- **Revocations run OUTSIDE the transaction** — throwing `UnauthorizedError` inside
  it would roll the DELETE back and leave the family usable
- **MAX_SESSIONS_PER_USER counts families, not rows** — a rotated family can hold
  several tokens but is a single browser session
- **Eviction deletes the entire oldest family** — never just the oldest token row
- **remember_me is persisted on the session** — rotations keep extending the session
  with the same TTL the login chose
- **getRefreshTtlSeconds() is the single source of the TTL in seconds** — used by both
  `expires_at` and the cookie `Max-Age`, so they can never diverge

## rememberMe

- **rememberMe is optional** — field in login request body, defaults to `false`
- **rememberMe=false (default)** → refresh token TTL = `JWT_REFRESH_EXPIRES_IN` (7d)
- **rememberMe=true** → refresh token TTL = `JWT_REFRESH_REMEMBER_TTL` (30d)
- **Cookie maxAge always matches the chosen TTL** — never diverges
- **Access token duration is unaffected** — always `JWT_ACCESS_EXPIRES_IN` (15m)
- **rememberMe not available on register** — register always uses default TTL

## Admin Role

- **pgEnum('user_role', ['user', 'admin'])** — DB-level constraint, replaces loose text column
- **role included in JWT payload** — `{ sub: userId, email, role }` at issue time
- **requireAdmin preHandler** — shared Fastify hook at `src/hooks/admin-guard.ts`
- **requireAdmin always used WITH app.authenticate** — auth check runs first, then role check
- **ForbiddenError (403)** — custom error class for insufficient permissions
- **Categories CRUD protected** — POST/PATCH/DELETE require admin
- **No admin routes exist yet for user management** (list users, change roles, etc.) — future
- **Categories routes fixed** — previously accessed `request.user.role` without explicit auth, causing crashes on unauthenticated requests

## Onboarding Flow

### Email registration

1. POST /api/v1/auth/register → user + profile + signature + workspace + canvas created atomically
2. Frontend redirects to app selection screen
3. POST /api/v1/platform-apps/me → activates selected apps, sets onboarding_complete = true
4. Frontend redirects to dashboard

### OAuth registration

1. GET /api/v1/auth/github or /google → OAuth flow
2. POST /api/v1/auth/onboarding/username → username chosen (validated via usernameSchema)
3. POST /api/v1/auth/onboarding/complete → profile + signature + workspace + canvas created atomically
4. Frontend redirects to app selection screen
5. POST /api/v1/platform-apps/me → activates selected apps, sets onboarding_complete = true
6. Frontend redirects to dashboard

## Documents ↔ Organizations

- **documents.organization_id is nullable** — a document belongs to at most one organization
- **FK is ON DELETE SET NULL** — deleting an organization unlinks its documents instead of deleting them
- **organizationId is accepted on create and update** — resolved by id first, then by lowercased orgname
- **The organization link is mutable** — it can change on a draft and on a published document alike
- **Only ACCEPTED members can link a document** — any role (owner/admin/member) is enough
- **Missing org answers 404** — a private org the author cannot see answers 404 too, so existence is never leaked
- **Visible org + non-member answers 403** — ForbiddenError('You must be a member of this organization')
- **Clearing the link (null) is always allowed** — the author can always unlink the document
- **The membership is only revalidated when the value changes** — an autosave resending the current organizationId answers 200 even for an author who lost the membership
- **Publish revalidates the membership** — an author removed from the org gets 403 and the document stays a draft
- **Reads expose `organization: { id, orgname, name } | null`** — the field is part of every document read and card
- **A private org is only revealed to the document's own author** — every other reader sees `organization: null`
- **The link survives a membership removal** — a document keeps its organization reference even if the author leaves
- **The public feed accepts `?organization=<orgname>`** — same private-org 404 rule as the organization listing
- **GET /api/v1/org/:orgname/documents lists the org's published documents** — cursor pagination, feed shape, private-author rule applied
- **A private org answers 404 on the listing for non-members** — accepted members see it, pending members do not
- **mapOrganization() is the single privacy check** — lives in organizations.service.ts and is shared by documents, bookmarks and follows
- **Authorship stays personal** — a document published inside an org is still signed by its author only

## Platform Apps

Apps available at launch (seeded in `db/seed.ts`):

| Slug      | Name      | Description                                              |
| --------- | --------- | -------------------------------------------------------- |
| canvas    | Canvas    | Post-it canvas for capturing and connecting ideas        |
| publisher | Publisher | Write and publish articles, tutorials, and books         |
| reader    | Reader    | Highlight, annotate, and organize what you read          |
| dev-tools | Dev Tools | Code notes, sandboxed exercises, and technical tutorials |

## Feature Flags

- **Feature flags centralized in src/config/features.ts**
- **Always import features from features.ts — never read FEATURE\_\* env vars directly**
- **requireFeature() throws 503 — use in route handlers only**
- **Service-level checks use if (!features.x) return — silent skip**
- **Default state: email=false, oauth=false, emailQueue=false, codeSandbox=true, memory=true**
- **memory=true by default** — safe, degrades gracefully if GEMINI_API_KEY is missing
- **Enabling oauth requires all 4 OAuth env vars to be set**
- **Enabling email requires RESEND_API_KEY and EMAIL_FROM**
- **emailQueue only works if email is also enabled**
- **memory only generates embeddings if GEMINI_API_KEY is set** — otherwise silent no-op

## Response Format

**Success:**

```json
{ "data": <payload>, "error": null, "message": "string" }
```

**Error:**

```json
{
  "data": null,
  "error": { "code": "string", "message": "string" },
  "message": "string"
}
```

**Validation Error:**

```json
{
  "data": null,
  "error": { "code": "VALIDATION_ERROR", "message": "string", "fields": {} },
  "message": "string"
}
```

## Auth Routes

| Method | Endpoint                         | Description                   | Rate Limit |
| ------ | -------------------------------- | ----------------------------- | ---------- |
| POST   | /api/v1/auth/register            | Register new user             | 5/min      |
| POST   | /api/v1/auth/login               | Login with email or username (optional rememberMe) | 10/min     |
| POST   | /api/v1/auth/refresh             | Refresh access token          | None       |
| POST   | /api/v1/auth/logout              | Logout and invalidate session | None       |
| GET    | /api/v1/auth/onboarding/status   | Get onboarding step           | None       |
| POST   | /api/v1/auth/onboarding/username | Set username during OAuth onboarding | None |
| POST   | /api/v1/auth/onboarding/complete | Create onboarding records (profile, signature, workspace, canvas) | None |
| POST   | /api/v1/auth/verify-email        | Verify email address          | None       |
| POST   | /api/v1/auth/resend-verification | Resend verification email     | 3/hour     |
| POST   | /api/v1/auth/forgot-password     | Request password reset        | 3/hour     |
| POST   | /api/v1/auth/reset-password      | Reset password                | None       |

## OAuth Routes

| Method | Endpoint                              | Auth | Description                               |
| ------ | ------------------------------------- | ---- | ----------------------------------------- |
| GET    | /api/v1/auth/:provider                | No   | Redirect to GitHub/Google OAuth (state + PKCE cookies) |
| POST   | /api/v1/auth/:provider/link           | Yes  | Create a single-use link intent (httpOnly cookie)      |
| GET    | /api/v1/auth/:provider/link/start     | No   | Redirect to the provider when the intent cookie is live |
| GET    | /api/v1/auth/:provider/callback       | No   | Callback for login and linking (link cookie decides)   |
| DELETE | /api/v1/auth/account/unlink/:provider | Yes  | Unlink OAuth provider                     |

## Profile Routes

| Method | Endpoint                   | Auth | Description        |
| ------ | -------------------------- | ---- | ------------------ |
| GET    | /api/v1/profiles/:username | No   | Get public profile |
| GET    | /api/v1/profiles/me        | Yes  | Get own profile    |
| PATCH  | /api/v1/profiles/me        | Yes  | Update own profile |
| DELETE | /api/v1/profiles/me        | Yes  | Delete own account |

## Platform Apps Routes

| Method | Endpoint                        | Auth | Description                           |
| ------ | ------------------------------- | ---- | ------------------------------------- |
| GET    | /api/v1/platform-apps           | No   | List all available apps               |
| GET    | /api/v1/platform-apps/me        | Yes  | List apps activated by current user   |
| POST   | /api/v1/platform-apps/me        | Yes  | Activate apps (onboarding + settings) |
| DELETE | /api/v1/platform-apps/me/:appId | Yes  | Deactivate an app                     |

## Canvas Routes

| Method | Endpoint                    | Auth | Description                                    |
| ------ | --------------------------- | ---- | ---------------------------------------------- |
| GET    | /api/v1/canvas/me           | Yes  | Get user's canvas with all notes and positions |
| PATCH  | /api/v1/canvas/me/positions | Yes  | Batch update note positions on canvas          |

## Notes Routes

| Method | Endpoint          | Auth | Description                                |
| ------ | ----------------- | ---- | ------------------------------------------ |
| POST   | /api/v1/notes     | Yes  | Create note → triggers memory indexing job |
| GET    | /api/v1/notes     | Yes  | List notes (paginated, filterable)         |
| GET    | /api/v1/notes/:id | Yes  | Get note by ID                             |
| PATCH  | /api/v1/notes/:id | Yes  | Update note → re-indexes embedding         |
| DELETE | /api/v1/notes/:id | Yes  | Soft delete → removes position + embedding |

## Memory Routes

| Method | Endpoint                                     | Auth | Description                                |
| ------ | -------------------------------------------- | ---- | ------------------------------------------ |
| GET    | /api/v1/memory/search                        | Yes  | Semantic search: ?q=string&limit=10        |
| GET    | /api/v1/memory/related/:sourceType/:sourceId | Yes  | Related items for a specific content piece |
| GET    | /api/v1/memory/digest                        | Yes  | Weekly connections digest                  |

## Workspace Routes

| Method | Endpoint                          | Auth | Description               |
| ------ | --------------------------------- | ---- | ------------------------- |
| GET    | /api/v1/workspace/me              | Yes  | Get workspace with counts |
| PATCH  | /api/v1/workspace/me/color-labels | Yes  | Update color labels       |

## Public Routes (No Auth Required)

| Method | Endpoint                             | Description                              |
| ------ | ------------------------------------ | ---------------------------------------- |
| GET    | /api/v1/documents                    | Public document feed (cursor pagination) |
| GET    | /api/v1/documents/:username/:slug    | Full public document                     |
| GET    | /api/v1/profiles/:username           | Get public profile                       |
| GET    | /api/v1/profiles/:username/documents | Author's published documents             |
| GET    | /api/v1/categories                   | Get all categories (hierarchical)        |
| GET    | /api/v1/categories/:slug             | Get a category by slug                   |
| GET    | /api/v1/tags/popular                 | Get popular tags sorted by usage         |
| GET    | /api/v1/platform-apps                | List all available apps                  |
| GET    | /api/v1/org/:orgname/documents       | Organization's published documents       |

## Document Routes

| Method | Endpoint                      | Auth | Description                   |
| ------ | ----------------------------- | ---- | ----------------------------- |
| GET    | /api/v1/documents/me          | Yes  | List my documents (paginated) |
| GET    | /api/v1/documents/:id         | Yes  | Get one of my documents (full, for editor) |
| POST   | /api/v1/documents             | Yes  | Create document               |
| PATCH  | /api/v1/documents/:id         | Yes  | Update document               |
| PATCH  | /api/v1/documents/:id/publish | Yes  | Publish document              |
| DELETE | /api/v1/documents/:id         | Yes  | Soft delete document          |

## Security

- Security findings documented in `docs/SECURITY.md`
- Detailed remediation steps in `docs/SECURITY_REMEDIATION.md`
- Session planning in `docs/SECURITY_SESSIONS.md`
- Fix priorities aligned with ROADMAP.md phases
- Never merge a phase release without clearing its security gates

## Next Steps

MVP is complete. The following features are implemented and tested:
- Auth (email + OAuth), onboarding, platform apps
- Canvas with post-its (notes) and spatial positioning
- Semantic memory (pgvector + Gemini embeddings)
- Workspace with color labels
- Signatures (cryptographic authorship)
- Public profile routes
- Categories and tags (read-only)

Beta phase (next):
- Documents (CRUD + publish)
- Tutorial exercises with sandbox
- Likes and bookmarks
- Highlights and journals
- Document style templates
- Account management (linking, deletion)
- Memory full coverage (all source types)

Post-Beta (v1.0):
- Books and chapters
- Follows and social feed
- Memory full coverage (all source types)

Future:
- Memory map (visual cluster view)
- Comments on documents
- Sharevault
- Team workspaces
- Blockchain migration for signatures
- Notifications
- Analytics
- RSS feeds
- Monetization and plans
