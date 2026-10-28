#!/usr/bin/env node
// Local replacement for the hosted CI checks. Runs on any OS with Node,
// pnpm and (for --rust) cargo; nothing here needs Docker unless you ask.
//
//   pnpm check                 web + share-service checks (the fast set)
//   pnpm check --rust          + cargo fmt, clippy, test
//   pnpm check --chromium      + the real-Chrome PDF render test (needs Chrome)
//   pnpm check --e2e           + Playwright (run once: pnpm --filter e2e exec playwright install chromium)
//   pnpm check --docker        + build the share-service image
//   pnpm check --all           everything above
//   pnpm check --keep-going    do not stop at the first failure
//   pnpm check --list          print the steps and exit
//
// The fast set: install, Biome lint, check:tauri-args, vitest, tsc + vite
// build, API client drift, server typecheck / arch / tests, OpenAPI drift.
// The Rust steps need ./dist, which the web build produces, so the fast
// set always runs first.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const all = args.has("--all");
const want = (flag) => all || args.has(flag);
const keepGoing = args.has("--keep-going");

if (args.has("--help") || args.has("-h")) {
  console.log(
    "Usage: pnpm check [--rust] [--chromium] [--e2e] [--docker] [--all] [--keep-going] [--list]",
  );
  process.exit(0);
}

const dummyDb = `file:${join(tmpdir(), "printninja_check_dummy.db").replace(/\\/g, "/")}`;
const cargo = "--manifest-path src-tauri/Cargo.toml";

/** @type {{name: string, cmd: string, env?: Record<string,string>, drift?: string}[]} */
const steps = [
  { name: "install", cmd: "pnpm install --frozen-lockfile" },
  { name: "lint", cmd: "pnpm lint" },
  { name: "tauri args", cmd: "pnpm check:tauri-args" },
  { name: "vitest", cmd: "pnpm test" },
  { name: "build", cmd: "pnpm build" },
  { name: "api client drift", cmd: "pnpm gen:api", drift: "src/lib/api/schema.d.ts" },
  { name: "server prisma client", cmd: "pnpm --filter server db:generate", env: { DATABASE_URL: dummyDb } },
  { name: "server typecheck", cmd: "pnpm --filter server typecheck" },
  { name: "server arch", cmd: "pnpm --filter server arch" },
  { name: "server tests", cmd: "pnpm --filter server test" },
  {
    name: "openapi drift",
    cmd: "pnpm --filter server openapi:generate",
    env: { DATABASE_URL: dummyDb, CORS_ORIGINS: "http://localhost:1420" },
    drift: "server/openapi/openapi.json",
  },
];

if (want("--rust")) {
  steps.push(
    { name: "cargo fmt", cmd: `cargo fmt ${cargo} -- --check` },
    { name: "cargo clippy", cmd: `cargo clippy ${cargo} --all-targets -- -D warnings` },
    { name: "cargo test", cmd: `cargo test ${cargo}` },
  );
}
if (want("--chromium")) {
  steps.push({
    name: "chromium render",
    cmd: `cargo test ${cargo} --test chromium_render -- --nocapture`,
    env: { PRINTNINJA_TEST_REAL_CHROMIUM: "1" },
  });
}
if (want("--e2e")) {
  steps.push(
    { name: "server build (e2e)", cmd: "pnpm --filter server build", env: { DATABASE_URL: dummyDb } },
    { name: "playwright e2e", cmd: "pnpm e2e" },
  );
}
if (want("--docker")) {
  steps.push({
    name: "server image",
    cmd: "docker build -f server/Dockerfile -t printninja-server:check .",
  });
}

if (args.has("--list")) {
  for (const s of steps) console.log(`${s.name.padEnd(24)} ${s.cmd}`);
  process.exit(0);
}

function run(cmd, env) {
  // One command string + shell: works for pnpm.cmd on Windows without
  // tripping Node's refusal to spawn .cmd files directly.
  return spawnSync(cmd, {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...env },
  }).status;
}

function drifted(file) {
  // `git diff --quiet` exits 1 when the regenerated file differs from HEAD.
  return spawnSync(`git diff --quiet -- ${file}`, { cwd: ROOT, shell: true }).status === 1;
}

const results = [];
for (const step of steps) {
  console.log(`\n=== ${step.name}: ${step.cmd}`);
  const t0 = Date.now();
  let ok = run(step.cmd, step.env) === 0;
  if (ok && step.drift && drifted(step.drift)) {
    console.error(`${step.drift} changed after regeneration: commit the regenerated file.`);
    ok = false;
  }
  results.push({ name: step.name, ok, secs: Math.round((Date.now() - t0) / 1000) });
  if (!ok && !keepGoing) break;
}

console.log("\n=== summary");
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(24)} ${r.secs}s`);
const skipped = steps.length - results.length;
if (skipped > 0) console.log(`(${skipped} step(s) not run after the failure; use --keep-going to run them)`);
process.exit(results.every((r) => r.ok) && skipped === 0 ? 0 : 1);
