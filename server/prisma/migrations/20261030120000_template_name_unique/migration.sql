-- One template name per owner. templates.name is COLLATE NOCASE, so the
-- index compares case-insensitively. No backfill: databases that already
-- hold duplicate names must be cleaned by hand before this applies.

-- CreateIndex
CREATE UNIQUE INDEX "templates_owner_id_name_key" ON "templates"("owner_id", "name");
