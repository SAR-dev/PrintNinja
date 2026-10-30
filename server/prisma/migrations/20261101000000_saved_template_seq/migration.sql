-- Saved mirrors join the sync stream: each save carries the saver's
-- sequence number, stamped on save and on every author edit/publish.
-- Dev phase: databases reset instead of migrating data, so there is no
-- backfill — every row written from here on gets a real sequence.
ALTER TABLE "saved_templates" ADD COLUMN "change_seq" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "saved_templates_user_id_change_seq_idx" ON "saved_templates"("user_id", "change_seq");
