CREATE INDEX "document_categories_category_id_idx" ON "document_categories" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "chat_channels_server_id_idx" ON "chat_channels" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "chat_server_members_profile_id_idx" ON "chat_server_members" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "documents_published_feed_idx" ON "documents" USING btree ("published_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "documents"."status" = 'published' AND "documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "highlights_profile_id_document_id_idx" ON "highlights" USING btree ("profile_id","document_id");--> statement-breakpoint
CREATE INDEX "journal_highlights_journal_id_idx" ON "journal_highlights" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "journals_workspace_id_idx" ON "journals" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "document_likes_document_id_idx" ON "document_likes" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "notes_canvas_id_idx" ON "notes" USING btree ("canvas_id");--> statement-breakpoint
CREATE INDEX "organization_members_profile_id_idx" ON "organization_members" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "document_tags_tag_id_idx" ON "document_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "tutorial_exercises_document_id_idx" ON "tutorial_exercises" USING btree ("document_id");