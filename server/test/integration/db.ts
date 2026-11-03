import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppDeps } from "../../src/domain/ports.js";
import { createDbClient, type DbClient } from "../../src/infra/db/client.js";
import { applyMigrations } from "../../src/infra/db/migrate.js";
import { createSavedRepository } from "../../src/infra/db/saved.js";
import { createSessionRepository } from "../../src/infra/db/sessions.js";
import { createSyncRepository } from "../../src/infra/db/sync.js";
import { createTemplateRepository } from "../../src/infra/db/templates.js";
import { createDatasetRepository } from "../../src/infra/db/datasets.js";
import { createSettingRepository } from "../../src/infra/db/settings.js";
import { createFontRepository } from "../../src/infra/db/fonts.js";
import { createProfileRepository } from "../../src/infra/db/profiles.js";
import { createUserRepository } from "../../src/infra/db/users.js";
import { createPasswordHasher } from "../../src/infra/security/passwordHasher.js";
import { createTokenService } from "../../src/infra/security/tokens.js";
import { testConfig } from "../helpers.js";

export interface TestStack {
  db: DbClient;
  stop: () => Promise<void>;
}

const isBusyFileError = (err: unknown): boolean =>
  err instanceof Error &&
  ((err as NodeJS.ErrnoException).code === "EPERM" ||
    (err as NodeJS.ErrnoException).code === "EBUSY");

/**
 * Deletes a directory from a short-lived detached child process, retrying
 * for up to a minute. Used when the current process cannot delete the
 * directory (see sweepForLockedDir); the child is a separate process, so it
 * succeeds as soon as the lock goes away — typically right after the
 * vitest worker that held it exits.
 */
function sweepInChildProcess(dir: string): void {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
const dir = process.env.PN_TEST_CLEAN_DIR;
const deadline = Date.now() + 60_000;
(function sweep() {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    if (Date.now() < deadline) setTimeout(sweep, 500);
  }
})();`,
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, PN_TEST_CLEAN_DIR: dir },
    },
  );
  child.unref();
}

/**
 * One local SQLite file per test file (no containers, no network), migrated
 * with the same runner production boots with — so integration always
 * exercises the committed migration files, never a hand-built schema.
 */
export async function startTestDatabase(): Promise<TestStack> {
  const dir = mkdtempSync(join(tmpdir(), "printninja-test-"));
  const url = `file:${join(dir, "test.db")}`;
  await applyMigrations({ url });
  const db = createDbClient(url);
  return {
    db,
    stop: async () => {
      await db.$disconnect();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        if (!isBusyFileError(err)) throw err;
        // On this Windows setup the libsql native binding keeps the
        // database file locked until the very process that opened it
        // exits — close() and $disconnect() do not release the handle —
        // so no in-process retry can ever succeed. A detached child
        // (which does not hold the handle) sweeps it as soon as the
        // lock goes away; the worst case is a leftover %TEMP% dir.
        sweepInChildProcess(dir);
      }
    },
  };
}

/** Wipes every table; sessions and user_sync cascade from users. Foreign
 * keys are off for the wipe only, so child rows never block their parent. */
export async function truncateAll(db: DbClient): Promise<void> {
  await db.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
  try {
    for (const table of [
      "template_use_daily",
      "saved_templates",
      "template_versions",
      "templates",
      "font_files",
      "fonts",
      "user_settings",
      "printer_profiles",
      "sample_datasets",
      "tombstones",
      "user_sync",
      "sessions",
      "users",
    ]) {
      await db.$executeRawUnsafe(`DELETE FROM "${table}"`);
    }
  } finally {
    await db.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  }
}

/** Production-shaped deps over the test database. Argon2 uses the
 * configured (production) parameters — register and login stay fast
 * enough to run unlowered, which is itself the point. */
export function realDeps(db: DbClient): AppDeps {
  const config = testConfig();
  return {
    users: createUserRepository(db),
    sessions: createSessionRepository(db),
    hasher: createPasswordHasher({
      memoryKib: config.argon2MemoryKib,
      timeCost: config.argon2TimeCost,
      parallelism: config.argon2Parallelism,
    }),
    tokens: createTokenService(),
    clock: { now: () => new Date() },
    ids: { newId: () => crypto.randomUUID() },
    sessionTtlDays: config.sessionTtlDays,
    templates: createTemplateRepository(db),
    datasets: createDatasetRepository(db),
    profiles: createProfileRepository(db),
    settings: createSettingRepository(db),
    fonts: createFontRepository(db),
    saved: createSavedRepository(db),
    sync: createSyncRepository(db),
  };
}
