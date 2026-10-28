import { describe, expect, it, vi } from "vitest";
import { TimeoutError, withTimeout } from "@/lib/withTimeout";

describe("withTimeout", () => {
  it("passes through a promise that answers in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, "op")).resolves.toBe(7);
    await expect(
      withTimeout(Promise.reject(new Error("nope")), 1000, "op"),
    ).rejects.toThrow("nope");
  });

  it("rejects with a TimeoutError naming the wait", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => {}), 80_000, "test_printer");
    const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(80_000);
    await assertion;
    await expect(pending).rejects.toThrow("test_printer timed out after 80s");
    vi.useRealTimers();
  });
});
