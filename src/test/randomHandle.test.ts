import { describe, expect, it } from "vitest";
import { randomHandle } from "@/lib/randomHandle";

// Same rule SignInScreen and the server apply to handles.
const HANDLE_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

describe("randomHandle", () => {
  it("always produces a handle the server would accept", () => {
    for (let i = 0; i < 500; i++) {
      expect(randomHandle()).toMatch(HANDLE_RE);
    }
  });

  it("covers the extremes of the random range without leaving it", () => {
    expect(randomHandle(() => 0)).toMatch(HANDLE_RE);
    expect(randomHandle(() => 0.999999)).toMatch(HANDLE_RE);
  });

  it("varies between calls", () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomHandle()));
    expect(seen.size).toBeGreaterThan(10);
  });
});
