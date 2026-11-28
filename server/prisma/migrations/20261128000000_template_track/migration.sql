-- Scene (label) templates share the template table with document templates.
-- The track selects which payload is authoritative; old rows stay `html`.

-- AlterTable
ALTER TABLE "templates" ADD COLUMN "track" TEXT NOT NULL DEFAULT 'html';
ALTER TABLE "templates" ADD COLUMN "scene_json" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "template_versions" ADD COLUMN "track" TEXT NOT NULL DEFAULT 'html';
ALTER TABLE "template_versions" ADD COLUMN "scene_json" TEXT NOT NULL DEFAULT '';
