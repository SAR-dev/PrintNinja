-- Account recovery (password reset without email): the SHA-256 hex of a
-- one-time recovery code. Nullable: accounts that predate this have no
-- code until they make one in Settings.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "recovery_code_hash" TEXT;
