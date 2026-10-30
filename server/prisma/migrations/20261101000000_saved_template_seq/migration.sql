-- Saved mirrors join the sync stream: each save carries the saver's
-- sequence number, stamped on save and on every author edit/publish.
-- The backfill hands every existing save its owner's current next_seq,
-- which is larger than any cursor that owner has seen, so the next pull
-- delivers every legacy save exactly once.
ALTER TABLE "saved_templates" ADD COLUMN "change_seq" INTEGER NOT NULL DEFAULT 1;

UPDATE "saved_templates"
SET "change_seq" = COALESCE(
  (SELECT "next_seq" FROM "user_sync" WHERE "user_id" = "saved_templates"."user_id"),
  1
);

CREATE INDEX "saved_templates_user_id_change_seq_idx" ON "saved_templates"("user_id", "change_seq");
