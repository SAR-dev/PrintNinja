import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// UI text uses the named scale in tailwind.config.ts (caption 12px floor,
// body-sm 13, body 14, title 18, display 24), never an ad-hoc pixel size —
// 11px next to 12px next to 13px is what made the helper lines and table
// captions read as three different UIs. Print templates are separate and
// excluded, as are these test files.
const ARBITRARY_PX = /\btext-\[\d+px\]/;
const ROOTS = ["../pages", "../components"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}

describe("type scale", () => {
  it("pages and components use no arbitrary pixel font sizes", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(path.resolve(__dirname, root))) {
        readFileSync(f, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (ARBITRARY_PX.test(line))
              offenders.push(`${path.relative(process.cwd(), f)}:${i + 1}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
