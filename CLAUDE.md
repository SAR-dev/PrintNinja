## Commits

Commit automatically when a change is complete and validated — do not wait to be asked. Every commit message is a single line in `type: short description` form (e.g. `feat: its a feature`), using `feat:`, `fix:`, `docs:`, `chore:`, `test:` or `refactor:` as the type. No body, no bullet lists, no Co-Authored-By or other attribution lines.

## Running tests locally (Docker, not native)

The heavy test suites run in Linux containers, not natively:

- Rust tests: `pnpm test:rust` (compose: `src-tauri/docker-compose.test.yml`). Never a bare `cargo test` for the full suite: the desktop crate's debug build peaks at several gigabytes natively, while the container caps `CARGO_BUILD_JOBS` at 2 and memory at 6 GB (an over-sized run fails fast inside the box) and keeps `target/` in a named volume, so only the first run compiles everything. `pnpm test:rust:report` additionally writes a JUnit report.
- Playwright (app-e2e): `pnpm e2e:docker` (compose: `e2e/docker-compose.e2e.yml`). It mirrors the CI `app-e2e` job (Ubuntu 24.04 fonts, Chromium). On Windows the native `pnpm e2e` cannot always bind the worker ports and host-rendered screenshots never match the committed Linux baselines.
- `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` are fine natively (check-only, low memory).
- Details: `docs/DEVELOPMENT.md` ("Run the Rust tests in Docker") and the compose files above.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. When the answer is under a Markdown heading, `graphify section "<heading>"` prints that section's text, so the .md need not be opened. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
