import { describe, expect, it } from "vitest";
import { NEW_WINDOW_DAYS, isRecentlyPublished } from "@/lib/share/recent";

const now = Date.parse("2026-06-01T00:00:00Z");
const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

describe("isRecentlyPublished", () => {
  it("qualifies within the window", () => {
    expect(isRecentlyPublished(daysAgo(0), now)).toBe(true);
    expect(isRecentlyPublished(daysAgo(NEW_WINDOW_DAYS), now)).toBe(true);
  });

  it("excludes older, future and missing dates", () => {
    expect(isRecentlyPublished(daysAgo(NEW_WINDOW_DAYS + 1), now)).toBe(false);
    expect(isRecentlyPublished(new Date(now + 60_000).toISOString(), now)).toBe(
      false,
    );
    expect(isRecentlyPublished(null, now)).toBe(false);
    expect(isRecentlyPublished("not a date", now)).toBe(false);
  });
});
