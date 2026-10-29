import { describe, it, expect } from "vitest";
import { AUTOMATION_TABS } from "@/pages/Automation";
import {
  AUTOMATION_SEARCH_ENTRIES,
  AUTOMATION_TAB_ENTRIES,
} from "@/lib/shell/automationSearch";
import en from "@/lib/i18n/locales/en";
import ja from "@/lib/i18n/locales/ja";

const dig = (obj: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);

describe("automation search index", () => {
  it("only points at tabs the Automation page has", () => {
    const tabs = AUTOMATION_TABS as readonly string[];
    for (const e of AUTOMATION_TAB_ENTRIES) expect(tabs).toContain(e.tab);
    for (const e of AUTOMATION_SEARCH_ENTRIES) expect(tabs).toContain(e.tab);
  });

  it("covers every tab", () => {
    expect(AUTOMATION_TAB_ENTRIES.map((e) => e.tab).sort()).toEqual(
      [...AUTOMATION_TABS].sort(),
    );
  });

  it("has a label in both languages and unique field ids", () => {
    const seen = new Set<string>();
    for (const e of [...AUTOMATION_TAB_ENTRIES, ...AUTOMATION_SEARCH_ENTRIES]) {
      expect(typeof dig(en, e.labelKey)).toBe("string");
      expect(typeof dig(ja, e.labelKey)).toBe("string");
    }
    for (const e of AUTOMATION_SEARCH_ENTRIES) {
      expect(seen.has(e.field)).toBe(false);
      seen.add(e.field);
    }
  });
});
