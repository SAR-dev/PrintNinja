import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Unit + integration (REFACTORING.md section 11). API workflows live
    // in test/e2e/*.e2e.ts and run through vitest.e2e.config.mts against
    // a running container, never in the default pass.
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**"],
    // The OpenAPI validation and the concurrent-writes test are CPU-heavy
    // (real Argon2 hashing, full document generation) and can exceed the
    // default 5s under a parallel check:full run. Twenty seconds leaves
    // headroom without masking a genuine hang.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/domain/**/*.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
