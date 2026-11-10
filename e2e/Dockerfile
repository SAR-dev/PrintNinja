# CI-faithful e2e container.
#
# CI (the app-e2e job in .github/workflows/ci.yml) runs the Playwright suite
# on an ubuntu-latest runner: Node 22 + pnpm 10 + Chromium installed via
# `playwright install --with-deps chromium`. This image reproduces that —
# ubuntu:24.04 is the runner's distro, so the committed screenshot baselines
# (font-bound to the runner) compare cleanly, and Node 22 comes from
# NodeSource (the same official builds actions/setup-node installs in CI).
#
# Running e2e in this box instead of on the host removes two host-OS hazards:
# - Windows cannot always bind the worker ports (EACCES on 127.0.0.1:3101),
#   which kills globalSetup before a single test runs.
# - host-rendered screenshots never match the Linux baselines.
#
# The workspace is copied in at build time (the image is rebuilt on each
# `pnpm e2e:docker`), so the image always matches the current checkout and
# never goes stale. The dependency and Chromium layers are cached, so a code
# edit re-runs only the (fast) copy + server-build layers, not pnpm install
# or the Chromium download.
FROM ubuntu:24.04

# Node 22 (the repo's engines field pins 22.x; CI installs the same version
# via actions/setup-node). NodeSource serves the official Node builds.
#
# gcc + libc6-dev: globalSetup links the vendored virtual printer with cargo,
# and rustc shells out to `cc`. The CI runner ships build tools preinstalled;
# a bare ubuntu image does not, so provide them explicitly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg gcc libc6-dev \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# pnpm 10, the same major CI installs (pnpm/action-setup@v5, version 10).
# Installed through npm rather than corepack, which Node 22 deprecates. The
# lockfile is lockfileVersion 9.0, stable across pnpm 10.x, so
# --frozen-lockfile below matches CI exactly.
RUN npm install -g pnpm@10

# Rust for the vendored virtual printer (e2e/support/virtual-printer), which
# globalSetup builds with `cargo build`. The repo pins 1.90.0 for the Tauri
# crate (rust-toolchain.toml); the printer is a separate std-only crate, so
# pinning the same channel keeps the two in lockstep without dragging
# clippy/rustfmt into this image.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain 1.90.0
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /workspace

# Dependency layer: install from the manifests + lockfile only, so a code
# edit does not re-run pnpm install. The three workspace package.json files
# and the lockfile fully determine the tree; native postinstall scripts
# (esbuild, argon2, prisma engines) run here, so they are built for Linux.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY server/package.json ./server/
COPY e2e/package.json ./e2e/
RUN pnpm install --frozen-lockfile

# Chromium + system dependencies, exactly as CI installs them. Cached: it
# re-runs only when the Playwright version in the lockfile changes.
RUN pnpm --filter e2e exec playwright install --with-deps chromium

# Source layer (changes often). The service is built from the current code;
# the Prisma client is generated first (it is gitignored, so it is not in
# the build context). The dummy DATABASE_URL only satisfies config loading —
# generate connects to nothing (same trick as the server image and CI).
COPY . .
RUN DATABASE_URL="file:/tmp/printninja_e2e_dummy.db" \
    pnpm --filter server db:generate \
    && pnpm --filter server build

# Headless, single-process run.
ENV CI=1
CMD ["pnpm", "--filter", "e2e", "test"]
