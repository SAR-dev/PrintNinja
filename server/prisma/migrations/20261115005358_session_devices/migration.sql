-- Signed-in device list (MISSING_FEATURES item 32): every session gets
-- an opaque public id for the sessions API — never the token or its
-- hash — plus a short device label read from the User-Agent at sign-in
-- and a last-used timestamp bumped while the session authenticates.
--
-- The sessions table is rewritten (SQLite cannot add a NOT NULL column
-- without one) and the public id is generated in SQL: Prisma's uuid()
-- default is client-side, so it cannot backfill existing rows itself.
-- Sessions have no child tables; the pragmas mirror Prisma's own
-- table-rewrite shape.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_sessions" (
    "token_hash" TEXT NOT NULL PRIMARY KEY,
    "public_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_label" TEXT NOT NULL DEFAULT '',
    "last_used_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_sessions" ("created_at", "expires_at", "public_id", "token_hash", "user_id")
SELECT "created_at", "expires_at",
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-' ||
    '4' || lower(substr(hex(randomblob(2)), 2)) || '-' ||
    (CASE abs(random() % 4) WHEN 0 THEN '8' WHEN 1 THEN '9' WHEN 2 THEN 'a' ELSE 'b' END) ||
    lower(substr(hex(randomblob(2)), 2)) || '-' ||
    lower(hex(randomblob(6))),
    "token_hash", "user_id"
FROM "sessions";
DROP TABLE "sessions";
ALTER TABLE "new_sessions" RENAME TO "sessions";
CREATE UNIQUE INDEX "sessions_public_id_key" ON "sessions"("public_id");
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
