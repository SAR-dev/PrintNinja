import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import path from "path";

const require = createRequire(import.meta.url);
const pkg = require("./package.json") as { version: string };

export default defineConfig({
  plugins: [react()],
  // Same baked version as the app build (see vite.config.ts), so web-mode
  // fallbacks resolve identically under test.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: "jsdom",
    // The Designer's desktop suites mount the heaviest trees (preview iframe
    // included); under a full parallel run they need 5–8s of wall time, past
    // the default 5s test timeout. Twenty seconds leaves headroom for CI
    // without masking a genuine hang.
    testTimeout: 20_000,
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // server/ and e2e/ have their own runners (Vitest node env, Playwright);
      // the default include pattern would run them here under jsdom.
      "server/**",
      "e2e/**",
    ],
    // Vitest replaces every .css import with an empty string, `?raw` included.
    // The per-template compiler reads Tailwind's own stylesheets that way, so
    // those (and only those) must come through intact.
    css: { include: [/\/tailwindcss\/(theme|preflight|utilities)\.css/] },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
