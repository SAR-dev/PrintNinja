import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import "@/lib/i18n";
import {
  _clearRefreshables,
  refreshAll,
  registerRefreshable,
} from "@/lib/refresh/registry";
import { manualRefresh } from "@/lib/refresh/manual";
import { useRefreshable } from "@/lib/refresh/useRefreshable";

const state = vi.hoisted(() => ({
  signedIn: true,
  cacheNow: vi.fn(async (_opts?: { force?: boolean }) => ({
    ok: true,
    error: null,
  })),
}));
const notify = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
}));

vi.mock("@/lib/share/client", () => ({
  isSignedIn: () => Promise.resolve(state.signedIn),
}));
vi.mock("@/lib/sync/useSyncStatus", () => ({
  cacheNow: (opts?: { force?: boolean }) => state.cacheNow(opts),
}));
vi.mock("@/lib/notify", () => notify);

beforeEach(() => {
  state.signedIn = true;
  state.cacheNow = vi.fn(async (_opts?: { force?: boolean }) => ({
    ok: true,
    error: null,
  }));
  notify.notifySuccess.mockClear();
  notify.notifyError.mockClear();
  notify.notifyInfo.mockClear();
  _clearRefreshables();
});

afterEach(() => {
  _clearRefreshables();
});

describe("refreshAll", () => {
  it("pulls the server cache when signed in and runs every part", async () => {
    const run = vi.fn(async () => {});
    registerRefreshable({ id: "a", label: () => "A", run });
    const res = await refreshAll();
    expect(state.cacheNow).toHaveBeenCalledWith({ force: true });
    expect(res.core).toEqual({ ok: true, error: null, attempted: true });
    expect(res.parts).toEqual([
      { id: "a", label: "A", status: "succeeded", detail: null },
    ]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("skips the server pull when signed out (no retry loop)", async () => {
    state.signedIn = false;
    const res = await refreshAll();
    expect(state.cacheNow).not.toHaveBeenCalled();
    expect(res.core).toEqual({ ok: true, error: null, attempted: false });
  });

  it("reports a failed part with its error, keeps the others", async () => {
    const ok = vi.fn(async () => {});
    const bad = vi.fn(async () => {
      throw new Error("boom");
    });
    registerRefreshable({ id: "ok", label: () => "OK", run: ok });
    registerRefreshable({ id: "bad", label: () => "Bad", run: bad });
    const res = await refreshAll();
    expect(res.parts.find((p) => p.id === "ok")).toMatchObject({
      status: "succeeded",
    });
    expect(res.parts.find((p) => p.id === "bad")).toMatchObject({
      status: "failed",
      detail: "boom",
    });
  });

  it("honors skipReason and the active flag", async () => {
    registerRefreshable({
      id: "skip",
      label: () => "Skip",
      run: vi.fn(),
      skipReason: () => "LAN permission off",
    });
    const inactive = vi.fn(async () => {});
    registerRefreshable({
      id: "off",
      label: () => "Off",
      run: inactive,
      active: () => false,
    });
    const res = await refreshAll();
    expect(res.parts).toEqual([
      {
        id: "skip",
        label: "Skip",
        status: "skipped",
        detail: "LAN permission off",
      },
    ]);
    expect(inactive).not.toHaveBeenCalled();
  });
});

describe("manualRefresh", () => {
  it("toasts 'Up to date' when everything succeeds", async () => {
    manualRefresh();
    await vi.waitFor(() =>
      expect(notify.notifySuccess).toHaveBeenCalledTimes(1),
    );
    expect(notify.notifySuccess).toHaveBeenCalledWith("Up to date");
  });

  it("names the failed parts and offers Retry", async () => {
    registerRefreshable({
      id: "bad",
      label: () => "History",
      run: async () => {
        throw new Error("boom");
      },
    });
    manualRefresh();
    await vi.waitFor(() => expect(notify.notifyError).toHaveBeenCalledTimes(1));
    const [msg, opts] = notify.notifyError.mock.calls[0] as [
      string,
      { action: { label: string } },
    ];
    expect(msg).toBe("Refresh failed: History");
    expect(opts.action.label).toBe("Retry");
  });

  it("shows a skipped part's reason as an info toast", async () => {
    registerRefreshable({
      id: "lan",
      label: () => "Printers",
      run: vi.fn(),
      skipReason: () => "Local network permission is off",
    });
    manualRefresh();
    await vi.waitFor(() => expect(notify.notifyInfo).toHaveBeenCalledTimes(1));
    expect(notify.notifyInfo).toHaveBeenCalledWith(
      "Local network permission is off",
      { id: "refresh-skipped:lan" },
    );
  });

  it("ignores a second tap while a refresh is running", async () => {
    let done: () => void;
    const gate = new Promise<void>((r) => {
      done = r;
    });
    const run = vi.fn(() => gate);
    registerRefreshable({ id: "slow", label: () => "Slow", run });
    manualRefresh();
    manualRefresh(); // second tap while the first is still running
    done!();
    await vi.waitFor(() =>
      expect(notify.notifySuccess).toHaveBeenCalledTimes(1),
    );
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("useRefreshable", () => {
  it("unregisters on unmount, so navigating away drops the part", async () => {
    const run = vi.fn(async () => {});
    const { unmount } = renderHook(() =>
      useRefreshable("gone", { label: () => "Gone", run }),
    );
    unmount();
    const res = await refreshAll();
    expect(res.parts).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
