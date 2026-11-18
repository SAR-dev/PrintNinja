import { describe, it, expect } from "vitest";
import en from "@/lib/i18n/locales/en";

/**
 * 4.11 (docs/todo/DESIGN_IMPROVEMENTS.md): page and section names come from
 * one place (docs/GLOSSARY.md), and copy may only reference names that
 * still exist. These rules scan every English string for section and page
 * references and fail when a name is not a real one — so renaming a
 * section in the settings list breaks here instead of silently leaving
 * stale "the Share section" pointers behind.
 */

function* stringsOf(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* stringsOf(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      yield* stringsOf(item);
    }
  }
}

const allStrings = [...stringsOf(en)];

/** The settings section names, exactly as the Settings page renders them. */
const sections = Object.entries(en.settings_page)
  .filter(([key]) => key.startsWith("section_"))
  .map(([, value]) => String(value));

/** The top-level page names, from the navigation. */
const pages = Object.values(en.nav).filter(
  (value): value is string => typeof value === "string",
);

/** "Devices and turn on sharing" → "Devices": the reference is the first
 * word group; the sentence continues after a conjunction. */
function firstTerm(name: string): string {
  return name.split(/\s+(?:and|then|or|to)\s+/i)[0].trim();
}

describe("section and page name references", () => {
  it("only references settings sections that exist", () => {
    const bad: string[] = [];
    for (const text of allStrings) {
      // "the Account & sync section"
      for (const m of text.matchAll(
        /\bthe ([A-Z][A-Za-z0-9 &/'-]*?) section\b/g,
      )) {
        if (!sections.includes(firstTerm(m[1]))) bad.push(m[1]);
      }
      // "Settings → Data & network" — a "Settings → X" claim names a section
      for (const m of text.matchAll(
        /Settings\s*→\s*([^→.;,]+?)(?=\s*[.;:]|\s*→|$)/g,
      )) {
        if (!sections.includes(firstTerm(m[1]))) bad.push(m[1]);
      }
    }
    expect(bad).toEqual([]);
  });

  it("only references pages that exist after 'PrintNinja →'", () => {
    const bad: string[] = [];
    for (const text of allStrings) {
      for (const m of text.matchAll(
        /PrintNinja\s*→\s*([^→.;,]+?)(?=\s*[.;:]|\s*→|$)/g,
      )) {
        if (!pages.includes(firstTerm(m[1]))) bad.push(m[1]);
      }
    }
    expect(bad).toEqual([]);
  });
});
