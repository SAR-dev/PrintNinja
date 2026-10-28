# Gitea CI — runners, secrets and release flow

CI lives in `.github/workflows/` and runs on self-hosted `act_runner`
instances against the Gitea repo. The workflow syntax is the GitHub
Actions dialect, so the files read like standard Actions workflows;
this doc covers only what is Gitea-specific: runners, secrets and the
release upload.

## Runners

There are no hosted runners: every `runs-on` label must be served by
your own `act_runner` instances. Register each runner with the labels
it can take:

```bash
act_runner register --labels ubuntu-latest:host,ubuntu-24.04:host
act_runner register --labels windows-latest:host
```

The jobs expect these labels: `ubuntu-latest` (most jobs),
`ubuntu-24.04` (`linux-build`), `windows-latest` (`rust-test-windows`,
`windows-build`).

Host prerequisites per runner:

- **Linux**: Docker (`server-image`, `server-e2e` shell out to it),
  passwordless `sudo` (Tauri system deps install via apt), plenty of
  disk (Android SDK + Rust target dir + Playwright browsers). Node,
  pnpm, Rust, Java and the Playwright browsers are installed by the
  jobs themselves; the Android SDK cmdline-tools are downloaded by the
  job when `sdkmanager` is missing.
- **Windows**: Visual Studio Build Tools (C++ workload) + WebView2 SDK
  for the Tauri MSI build. Node, pnpm and Rust come from the jobs.

## Secrets (repo Settings → Actions → Secrets)

| Secret | Used by |
|---|---|
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` | `android-build` APK/AAB signing (job fails without them rather than shipping a throwaway key) |
| `RELEASE_TOKEN` | `gitea-release` draft + uploads (PAT with repo write scope) |
| `SERVICE_URL`, `CRON_SECRET` | `server-cleanup` endpoint call |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | `server-migrate` live DB access |

## Schedules and manual runs

`e2e-nightly` (`0 3 * * *`) and `server-cleanup` (`17 3 * * *`) run on
their crons; all three ops workflows (`e2e-nightly`,
`server-cleanup`, `server-migrate`) also trigger by hand from the
Actions tab. Schedules only fire on the default branch.

## Release flow

Same as before, unchanged: `pnpm release patch --push` (or minor /
major) on `main` bumps every manifest, tags `vX.Y.Z` and pushes. The
tag run builds the MSI, deb/AppImage and APK/AAB, then `gitea-release`
creates a **draft** release through the forge API and attaches every
artifact (re-runs reuse the release instead of duplicating it). Open
the draft on the forge to publish.

The app's update badge follows the release: point it at the new home
with build-time env (defaults keep the old GitHub address, so existing
installs keep working until you flip it):

```bash
VITE_UPDATE_API=https://gitea.example.com/api/v1 \
VITE_UPDATE_REPO=owner/PrintNinja \
pnpm build
```

## Branch protection

Require `web-check`, `rust-check`, `rust-test-windows`,
`server-check` and `android-check` in the branch rules. `rust-check`
is the gate alias both Rust jobs must pass (a skipped required check
could otherwise let a merge through).

## First-run verification notes

- `actions/cache`, `upload-artifact` / `download-artifact@v4` and the
  `permissions:` / `concurrency` keys are exercised on the first green
  run; if the Gitea version predates any of them, pin that in this doc.
- `softprops/action-gh-release` is deliberately absent: it speaks only
  the GitHub API. The `gitea-release` job uses `curl` against
  `${{ github.server_url }}/api/v1` instead, so it works on any host.
- The update badge e2e fixture intercepts `api.github.com`; after
  flipping `VITE_UPDATE_API`, point that fixture at the new host too
  (`e2e/tests/mobile.mobile.e2e.ts`).
