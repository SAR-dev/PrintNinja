import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// All toasts go through src/lib/notify.ts (durations, dedupe, actions
// and placement live in one place), so importing `toast` from sonner
// anywhere else is a regression. Allowed: the wrapper itself and the
// Toaster component that renders them.
const ALLOWED = new Set([
  "src/lib/notify.ts",
  "src/components/ui/sonner.tsx",
]);

const ROOTS = ["../lib", "../components", "../pages"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}

describe("toast funnel", () => {
  it("nothing outside notify.ts renders toasts from sonner", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(path.resolve(__dirname, root))) {
        const rel = path.relative(process.cwd(), f);
        if (ALLOWED.has(rel)) continue;
        readFileSync(f, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (/from ["']sonner["']/.test(line))
              offenders.push(`${rel}:${i + 1}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
