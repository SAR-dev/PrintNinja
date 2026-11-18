import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// The glossary is the reference for every page, section, and feature name
// the UI and its strings use. These checks fail on references to names
// that the glossary does not define (DESIGN IMPROVEMENTS 4.11): add the
// term to docs/GLOSSARY.md rather than weakening the test.
const glossary = readFileSync(
  path.resolve(__dirname, "../../docs/GLOSSARY.md"),
  "utf8",
).toLowerCase();
const en = readFileSync(
  path.resolve(__dirname, "../lib/i18n/locales/en.ts"),
  "utf8",
);

/** The `key: "label"` pairs inside the `nav` block. */
function navLabels(): Array<[string, string]> {
  const lines = en.split("\n");
  const start = lines.findIndex((l) => l.trimStart().startsWith("nav: {"));
  expect(start).toBeGreaterThanOrEqual(0);
  const out: Array<[string, string]> = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("}")) break;
    const m = line.match(/^(\w+):\s*"([^"]+)"/);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

/** A `→ Target` reference after an arrow, where the target starts with a
    capital. The target ends at the enclosing quote, a comma, sentence
    punctuation, or a joining " and " / " or ". */
function arrowTargets(): string[] {
  const raw = [...en.matchAll(/→\s*([A-Z][^"\n]*)/g)].map((m) => m[1]);
  return raw.map((t) =>
    t
      .split(/\s+(?:and|or)\s+/)[0]
      .replace(/[\s.,!?]+$/, "")
      .trim(),
  );
}

describe("glossary coverage", () => {
  it("defines every page name used in the navigation", () => {
    const labels = navLabels();
    expect(labels.length).toBeGreaterThanOrEqual(8);
    for (const [key, label] of labels) {
      if (key === "more" || key === "more_title" || key.startsWith("group_"))
        continue;
      expect(
        glossary,
        `nav.${key} ("${label}") is missing from docs/GLOSSARY.md`,
      ).toContain(label.toLowerCase());
    }
  });

  it("defines the target of every '→' reference in the English strings", () => {
    const targets = arrowTargets();
    // "Wi-Fi / LAN → IPP" must be picked up, so the list cannot be empty
    // by accident.
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(
        glossary,
        `the arrow reference to "${target}" has no entry in docs/GLOSSARY.md`,
      ).toContain(target.toLowerCase());
    }
  });
});
