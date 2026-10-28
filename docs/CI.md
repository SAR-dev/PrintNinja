# Checks, releases and scheduled jobs (no hosted CI)

The repo has no GitHub Actions workflows. Everything CI used to do runs on
your own machine, with the commands below.

## Checks

```bash
pnpm check              # install, lint, tauri-args, vitest, build, API client drift,
                        # server typecheck / arch / tests, OpenAPI drift
pnpm check --rust       # + cargo fmt, clippy (-D warnings), cargo test
pnpm check --chromium   # + real-Chrome PDF render test (needs Chrome installed)
pnpm check --e2e        # + Playwright (once: pnpm --filter e2e exec playwright install chromium)
pnpm check --docker     # + build the share-service image
pnpm check:full         # all of the above
pnpm check --keep-going # run every step even after a failure
pnpm check --list       # print the steps and exit
```

Run `pnpm check` before you push and `pnpm check:full` before a release. The
Windows-only Rust code (`cfg(windows)`) only compiles on Windows, so run
`pnpm check --rust` on a Windows machine too if you touched the spooler.

## Production-parity e2e

The old nightly run tightened the e2e stack to production values and added
Firefox. To do the same by hand (bash):

```bash
E2E_RATE_LIMIT_MAX=1000 E2E_RATE_LIMIT_AUTH_MAX=10 E2E_RATE_LIMIT_AUTH_WINDOW_SECONDS=300 \
E2E_ARGON2_MEMORY_KIB=19456 E2E_ARGON2_TIME_COST=2 E2E_ARGON2_PARALLELISM=1 \
E2E_DOCS_ENABLED=true E2E_BROWSERS=chromium,firefox \
pnpm e2e
```

## Releasing

```bash
node scripts/release-local.mjs X.Y.Z            # bump, check, build here, no push
node scripts/release-local.mjs X.Y.Z --push     # + push main/tag, create/update the draft release
```

Run it on each OS you want installers for (Windows: MSI; Linux: deb and
AppImage; any OS with the Android SDK and keystore env vars: APK and AAB).
The draft release collects whatever each machine produced. Needs Node 22,
pnpm 10, Rust 1.90 and `gh` logged in. Details: [`RELEASE.md`](RELEASE.md).

`pnpm release patch|minor|major` only bumps, commits and tags; it builds
nothing.

The app's update badge follows the release: it queries
`{VITE_UPDATE_API}/repos/{VITE_UPDATE_REPO}/releases/latest`, which
defaults to this repo on `https://api.github.com`. Point it elsewhere
with build-time env when testing against another host:

```bash
VITE_UPDATE_API=https://api.github.com \
VITE_UPDATE_REPO=owner/PrintNinja \
pnpm build
```

The update badge e2e fixture intercepts `api.github.com`; after changing
`VITE_UPDATE_API`, point that fixture at the new host too
(`e2e/tests/mobile.mobile.e2e.ts`).

## Scheduled and ops jobs

| Old workflow | Now |
|---|---|
| `server-cleanup` (daily) | Vercel Cron, declared in `server/vercel.json`. Vercel sends `Authorization: Bearer $CRON_SECRET`, so keep `CRON_SECRET` set in the Vercel project. Docker/local runs clean up with the in-process timer |
| `server-migrate` (manual) | `DATABASE_URL=libsql://… DATABASE_AUTH_TOKEN=… pnpm --filter server db:apply` |
| `e2e-nightly` | Run it by hand, see above |

If you host the cleanup call somewhere other than Vercel (cron-job.org, a
home server), send `GET $SERVICE_URL/v2/internal/cleanup` with the header
`Authorization: Bearer $CRON_SECRET` once a day.

## Secrets

Nothing lives in GitHub any more. Keep these in a password manager and
export them in your shell when needed (template: `.secrets.example`):

| Secret | Used by |
|---|---|
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` | `release-local.mjs` APK/AAB signing. Key alias defaults to `printninja`; override with `ANDROID_KEYSTORE_ALIAS` |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | `db:apply` against the live database |
| `CRON_SECRET` | Vercel project env var; also needed if you call the cleanup endpoint by hand |

`gh release create/upload` uses your own `gh auth login`, so no token has to
be stored.
