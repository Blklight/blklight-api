-- Unique (follower_id, following_id) on follows, plus an index on following_id.
--
-- Hand-edited after `drizzle-kit generate`: the service checked for an existing
-- row before inserting, so a double click could store the same follow twice and
-- the generated ADD CONSTRAINT would abort on those rows.
--
-- Strategy: before adding the constraint, keep one row per pair (accepted over
-- pending over rejected, then the oldest) and delete the rest. Same documented
-- pattern as 0020/0022: this file stays in _journal.json and is applied by
-- `npm run db:migrate`.
DELETE FROM "follows" f
USING (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "follower_id", "following_id"
           ORDER BY CASE "status" WHEN 'accepted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, "created_at"
         ) AS rn
  FROM "follows"
) d
WHERE f."id" = d."id" AND d.rn > 1;--> statement-breakpoint
CREATE INDEX "follows_following_id_idx" ON "follows" USING btree ("following_id");--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_following_unique" UNIQUE("follower_id","following_id");
