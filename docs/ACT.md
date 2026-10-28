# Running CI locally with `act`

[`act`](https://github.com/nektos/act) executes the real workflows in
`.github/workflows/` inside Docker — the same steps GitHub runs, on
your machine. The GitHub pipeline stays the source of truth; this is
for fast local verification (and for releases when hosted runners are
unavailable).

## Setup

```bash
# Linux x64 binary into /usr/local/bin
curl -sSL https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash

# Docker must be running. First run pulls the runner images (slow, one time).
```

Copy the secrets template only for the jobs that need real services:

```bash
cp .secrets.example .secrets   # fill in values; .secrets is gitignored
```

## Quick start

From the repo root (`.actrc` already maps the Ubuntu images):

```bash
act -l                                  # list all jobs (validates parsing)
act pull_request -j web-check          # lint, tauri-args, build, vitest
act pull_request -j server-check       # service typecheck, tests, coverage
act pull_request -j rust-lint -j rust-test
act pull_request -j chromium-render
act push -e .github/act/tag-event.json -j version-check   # tag wiring dry-run
```

Add `--secret-file .secrets` when a job needs secrets
(`android-build` signing, `server-migrate`, `server-cleanup`).

The two Docker jobs need the host daemon inside the job container:

```bash
act pull_request -j server-image -v /var/run/docker.sock:/var/run/docker.sock
act pull_request -j server-e2e -v /var/run/docker.sock:/var/run/docker.sock \
  --secret-file .secrets
```

The full app suite runs like CI's nightly (Chromium; Firefox needs the
browsers the job installs itself):

```bash
act workflow_dispatch -j e2e-nightly
```

## What to skip, and why

- **Windows jobs** (`rust-test-windows`, `windows-build`) cannot run on
  Linux. PR checks do not need them; the Windows MSI still needs a real
  Windows runner (hosted, or self-hosted with the `windows-latest`
  label).
- **Release uploads** (`github-release`) call `gh release` with the
  automatic `GITHUB_TOKEN`, which `act` fakes. Either skip the job or
  pass a real PAT: `--secret GITHUB_TOKEN=<repo-scope PAT>`.
- **No cache server**: plain `act` has nowhere to store
  `actions/cache` (Rust target, Playwright browsers), so Rust and
  Android jobs download everything on every run — much slower than CI.
  Use `act` for correctness, not speed.
- **Ports**: the e2e jobs bind 1420 (vite), 3001+ (per-worker APIs)
  and 17717 (dev printer). Free them first if something else listens.
- **Event filters**: `-j` selects jobs; the `on:` trigger still has to
  match the event. `pull_request` covers the check jobs;
  `push -e .github/act/tag-event.json` covers tag-only jobs
  (`version-check`, release builds). The sample tag (`v0.1.0`) matches
  the current manifests, so `version-check` passes against it.
