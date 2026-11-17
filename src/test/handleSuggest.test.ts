import { describe, expect, it } from "vitest";
import { suggestHandles } from "@/lib/share/handleSuggest";

// Same rules the server enforces on register (see SignInScreen HANDLE_RE).
const HANDLE_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

describe("suggestHandles", () => {
  it("returns the requested number of suggestions", () => {
    expect(suggestHandles(3)).toHaveLength(3);
    expect(suggestHandles(5)).toHaveLength(5);
  });

  it("never repeats a handle in one batch", () => {
    for (let i = 0; i < 50; i++) {
      const batch = suggestHandles(6);
      expect(new Set(batch).size).toBe(batch.length);
    }
  });

  it("always returns valid, registerable handles", () => {
    for (let i = 0; i < 200; i++) {
      for (const handle of suggestHandles(3)) {
        expect(handle.length).toBeLessThanOrEqual(32);
        expect(HANDLE_RE.test(handle)).toBe(true);
      }
    }
  });
});
