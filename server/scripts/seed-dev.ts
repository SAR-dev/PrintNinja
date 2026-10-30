import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbClient } from "../src/infra/db/client.js";
import { createPasswordHasher } from "../src/infra/security/passwordHasher.js";
import { createSavedRepository } from "../src/infra/db/saved.js";
import { createTemplateRepository } from "../src/infra/db/templates.js";
import { createUserRepository } from "../src/infra/db/users.js";
import { publishTemplate } from "../src/domain/templates/templates.js";
import { putTemplate } from "../src/domain/templates/put.js";
import { saveTemplate } from "../src/domain/templates/saved.js";

// Dev-only seed data for manual checking: two users with known
// passwords, a few published templates, and saves between them, so
// Community, Saved mirrors and the sync stream all have something to
// show. Idempotent — fixed ids, existing rows are skipped. Never run
// against a real database: the passwords are public by design.
const PASSWORD = "demo1234";

const USERS = [
  { id: "11111111-1111-4111-8111-111111111111", handle: "demo" },
  { id: "22222222-2222-4222-8222-222222222222", handle: "sam" },
] as const;

const TEMPLATES = [
  {
    id: "33333333-3333-4333-8333-333333333333",
    owner: "demo",
    name: "Parcel Tag 80mm",
    summary: "Small address tag for 80 mm roll paper.",
    pageWMm: 80,
    pageHMm: 100,
    body: [
      '<div class="p-2 text-xs">',
      "  <p><strong>To:</strong> {{customer.name}}</p>",
      "  <p>{{customer.address}}, {{customer.city}} {{customer.zip}}</p>",
      '  {{barcode "code128" order.tracking}}',
      "</div>",
    ].join("\n"),
    publish: true,
  },
  {
    id: "44444444-4444-4334-8334-444444444444",
    owner: "demo",
    name: "Shipping Label 4x6",
    summary: "Sender, recipient, contents and a tracking barcode.",
    pageWMm: 102,
    pageHMm: 152,
    body: [
      '<div class="p-4 text-xs">',
      "  <p>Order #{{order.id}}</p>",
      "  <p><strong>From:</strong> {{store.name}}, {{store.address}}</p>",
      "  <p><strong>To:</strong> {{customer.name}}, {{customer.address}}</p>",
      '  {{barcode "code128" order.tracking}}',
      "</div>",
    ].join("\n"),
    publish: true,
  },
  {
    id: "55555555-5555-4335-8335-555555555555",
    owner: "demo",
    name: "Draft Flyer",
    summary: "Still private: only demo sees this one.",
    pageWMm: 210,
    pageHMm: 297,
    body: '<div class="p-4"><h1>{{title}}</h1></div>',
    publish: false,
  },
] as const;

// handle -> template names that handle saves.
const SAVES: Record<string, string[]> = {
  sam: ["Parcel Tag 80mm", "Shipping Label 4x6"],
};

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const { loadEnvFile } = await import("../src/config.js");
  loadEnvFile(resolve(here, ".."));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (server/.env or environment)");
    process.exit(2);
  }
  // Turso and other libsql:// remotes authenticate with a token, same
  // variable the migrate and reset scripts use.
  const authToken = process.env.DATABASE_AUTH_TOKEN;
  if (databaseUrl.startsWith("libsql://") && !authToken) {
    console.error("DATABASE_AUTH_TOKEN is required for a libsql:// URL");
    process.exit(2);
  }
  console.log(`seed target: ${describeTarget(databaseUrl, !!authToken)}`);
  const { createDbClient } = await import("../src/infra/db/client.js");
  const db = createDbClient(databaseUrl, authToken);
  try {
    await ping(db, databaseUrl);
    const users = createUserRepository(db);
    const templates = createTemplateRepository(db);
    const saved = createSavedRepository(db);
    const hasher = createPasswordHasher({
      memoryKib: 8192,
      timeCost: 2,
      parallelism: 1,
    });
    const byHandle = new Map<string, string>();

    for (const u of USERS) {
      const existing = await users.findByHandleKey(u.handle);
      if (existing) {
        console.log(`user ${u.handle}: exists (${existing.id}), skipped`);
        byHandle.set(u.handle, existing.id);
        continue;
      }
      const created = await users.create({
        id: u.id,
        handle: u.handle,
        handleKey: u.handle.toLowerCase(),
        passwordHash: await hasher.hash(PASSWORD),
      });
      byHandle.set(u.handle, created.id);
      console.log(`user ${u.handle}: created (${created.id})`);
    }

    const byName = new Map<string, string>();
    for (const t of TEMPLATES) {
      const ownerId = byHandle.get(t.owner)!;
      const existing = await templates.findById(t.id);
      if (existing) {
        console.log(
          `template "${t.name}": exists (rev ${existing.revision}, ` +
            `published ${existing.publishedAt !== null}), skipped`,
        );
        byName.set(t.name, t.id);
        continue;
      }
      const put = await putTemplate(
        { templates },
        {
          id: t.id,
          name: t.name,
          summary: t.summary,
          pageWMm: t.pageWMm,
          pageHMm: t.pageHMm,
          body: t.body,
        },
        ownerId,
      );
      byName.set(t.name, t.id);
      console.log(
        `template "${t.name}": put status ${put.status}, ` +
          `rev ${put.template.revision}, seq ${put.template.changeSeq}`,
      );
      if (t.publish) {
        const published = await publishTemplate(
          { templates },
          t.id,
          ownerId,
          new Date(),
        );
        console.log(
          `template "${t.name}": published at ${published.publishedAt?.toISOString()}`,
        );
      } else {
        console.log(`template "${t.name}": left private`);
      }
    }

    for (const [handle, names] of Object.entries(SAVES)) {
      const userId = byHandle.get(handle)!;
      for (const name of names) {
        // Repeat saves are idempotent: the mirror is just re-stamped.
        await saveTemplate(
          { templates, saved },
          userId,
          byName.get(name)!,
        );
        console.log(`${handle} saved "${name}"`);
      }
    }

    await verify(db);
    console.log("sign in with demo / demo1234 or sam / demo1234");
  } finally {
    await db.$disconnect();
  }
}

/** What the script thinks it is talking to. The token itself never logs. */
function describeTarget(databaseUrl: string, hasToken: boolean): string {
  if (databaseUrl.startsWith("libsql://")) {
    const host = databaseUrl.slice("libsql://".length).split("/")[0];
    return `turso remote ${host} (token ${hasToken ? "set" : "missing"})`;
  }
  return `local file ${databaseUrl}`;
}

/** Fail fast on a wrong address or a dead remote before writing a row. */
async function ping(db: DbClient, databaseUrl: string): Promise<void> {
  const started = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
  } catch (err) {
    throw new Error(
      `cannot reach ${describeTarget(databaseUrl, true)}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  console.log(`ping ok in ${Date.now() - started} ms`);
}

/** Read back everything the seed should have written, so a silent
 * no-op (wrong database, swallowed write) shows up here, not in the app. */
async function verify(db: DbClient): Promise<void> {
  const users = (await db.$queryRawUnsafe(
    `SELECT handle FROM users WHERE handle IN ('demo', 'sam') ORDER BY handle`,
  )) as { handle: string }[];
  const tpl = (await db.$queryRawUnsafe(
    `SELECT id, name, owner_id, published_at IS NOT NULL AS published
     FROM templates WHERE id IN (${TEMPLATES.map((t) => `'${t.id}'`).join(",")})`,
  )) as { id: string; name: string; owner_id: string; published: number }[];
  const saves = (await db.$queryRawUnsafe(
    `SELECT user_id, template_id FROM saved_templates`,
  )) as { user_id: string; template_id: string }[];
  console.log(
    `verify: users [${users.map((u) => u.handle).join(", ")}], ` +
      `templates [${tpl.map((t) => `${t.name}:${t.published ? "pub" : "priv"}`).join(", ")}], ` +
      `saves ${saves.length}`,
  );
  if (users.length !== 2 || tpl.length !== 3 || saves.length < 2) {
    throw new Error(
      "verify failed: the database does not hold the seeded rows — " +
        "check that this is the database the app reads",
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
