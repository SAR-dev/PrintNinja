# GitHub CI — runners, secrets and release flow

CI lives in `.github/workflows/` and runs on GitHub-hosted runners
against this repo.

## Runners

All jobs use GitHub-hosted runners: `ubuntu-latest` (most jobs),
`ubuntu-24.04` (`linux-build`), `windows-latest` (`rust-test-windows`,
`windows-build`). No self-hosting is needed; Docker, `sudo` and the
Android SDK cmdline-tools fallback in the Android jobs all work on the
hosted images as-is.

## Secrets (repo Settings → Secrets and variables → Actions → Secrets)

| Secret | Used by |
|---|---|
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` | `android-build` APK/AAB signing (job fails without them rather than shipping a throwaway key). Key alias defaults to `printninja`; override with the `ANDROID_KEYSTORE_ALIAS` env var if your key uses another alias |
| `SERVICE_URL`, `CRON_SECRET` | `server-cleanup` endpoint call |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | `server-migrate` live DB access |

There is no release PAT: `github-release` authenticates with the
automatic `GITHUB_TOKEN` (`permissions: contents: write` on that job).

## Schedules and manual runs

`e2e-nightly` (`0 3 * * *`) and `server-cleanup` (`17 3 * * *`) run on
their crons; all three ops workflows (`e2e-nightly`,
`server-cleanup`, `server-migrate`) also trigger by hand from the
Actions tab. Schedules only fire on the default branch.

## Release flow

Same as before, unchanged: `pnpm release patch --push` (or minor /
major) on `main` bumps every manifest, tags `vX.Y.Z` and pushes. The
tag run builds the MSI, deb/AppImage and APK/AAB, then
`github-release` creates a **draft** GitHub Release and attaches every
artifact (re-runs reuse the release and overwrite same-name assets
instead of duplicating them). Open the draft on GitHub to publish.

The app's update badge follows the release: it queries
`{VITE_UPDATE_API}/repos/{VITE_UPDATE_REPO}/releases/latest`, which
defaults to this repo on `https://api.github.com`. Point it elsewhere
with build-time env when testing against another host:

```bash
VITE_UPDATE_API=https://api.github.com \
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
  run.
- The `github-release` job uses the preinstalled `gh` CLI with
  `GITHUB_TOKEN`; no third-party release action or PAT is involved.
- The update badge e2e fixture intercepts `api.github.com`; after
  flipping `VITE_UPDATE_API`, point that fixture at the new host too
  (`e2e/tests/mobile.mobile.e2e.ts`).
