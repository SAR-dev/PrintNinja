import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";
import { Layout } from "@/components/Layout";

const shellState = vi.hoisted(() => ({
  share: { state: "online", handle: "rafi" } as
    | { state: "online"; handle: string }
    | { state: "offline" }
    | { state: "unconfigured" }
    | { state: "signed_out" },
  sync: {
    state: "synced",
    drafts: 0,
    lastPulledAt: null,
    lastError: null,
  } as {
    state: "synced" | "syncing" | "offline";
    drafts: number;
    lastPulledAt: string | null;
    lastError: string | null;
  },
  cacheNow: vi.fn(async () => {}),
}));

vi.mock("@/lib/shell/useShareStatus", () => ({
  useShareStatus: () => shellState.share,
}));

vi.mock("@/lib/sync/useSyncStatus", () => ({
  useSyncStatus: () => shellState.sync,
  cacheNow: (...args: unknown[]) =>
    (shellState.cacheNow as (...a: unknown[]) => Promise<void>)(...args),
}));

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/history"]}>
      <Layout>
        <h1>Page</h1>
      </Layout>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  shellState.share = { state: "online", handle: "rafi" };
  shellState.sync = {
    state: "synced",
    drafts: 0,
    lastPulledAt: null,
    lastError: null,
  };
  shellState.cacheNow.mockClear();
});

describe("topbar share + cache", () => {
  it("always shows the online badge, next to the cache button", () => {
    shellState.sync = {
      state: "synced",
      drafts: 1,
      lastPulledAt: null,
      lastError: null,
    };
    renderShell();
    // Connection signal stays online…
    expect(
      screen.getByTitle("Share service connected as rafi"),
    ).toBeInTheDocument();
    // …and the cache gets its own control, counting drafts in its tooltip.
    const sync = screen.getByTestId("sync-chip");
    expect(sync).toHaveAttribute(
      "title",
      expect.stringContaining("1 draft(s) not saved to the server"),
    );
    expect(sync.tagName).toBe("BUTTON");
  });

  it("opens Profile from the user badge", () => {
    renderShell();
    const badge = screen.getByTestId("topbar-profile");
    expect(badge.tagName).toBe("A");
    expect(badge).toHaveAttribute("href", "/settings?section=profile");
    // The handle is readable on desktop and the initial stands in on phones.
    expect(badge).toHaveTextContent("rafi");
    expect(badge).toHaveAttribute(
      "aria-label",
      "Account: rafi. Open your profile",
    );
  });

  it("names the account at the top of the phone More sheet", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const row = screen.getByTestId("more-account");
    expect(row).toHaveAttribute("href", "/settings?section=profile");
    expect(row).toHaveTextContent("Signed in as");
    expect(row).toHaveTextContent("rafi");
  });

  it("hides the account row when nobody is signed in", () => {
    shellState.share = { state: "signed_out" };
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByTestId("more-account")).toBeNull();
    expect(screen.queryByTestId("topbar-profile")).toBeNull();
  });

  it("runs a cache refresh when the cache button is clicked", async () => {
    renderShell();
    fireEvent.click(screen.getByTestId("sync-chip"));
    expect(shellState.cacheNow).toHaveBeenCalledOnce();
  });

  it("surfaces the last refresh error on the cache button", () => {
    shellState.sync = {
      state: "offline",
      drafts: 1,
      lastPulledAt: null,
      lastError: "template is 600000 bytes, limit 524288",
    };
    renderShell();
    // Still online at the share level…
    expect(
      screen.getByTitle("Share service connected as rafi"),
    ).toBeInTheDocument();
    // …but the button says why the refresh failed.
    expect(screen.getByTestId("sync-chip")).toHaveAttribute(
      "title",
      expect.stringContaining("template is 600000 bytes"),
    );
  });

  it("shows only the offline badge when the share is down", () => {
    shellState.share = { state: "offline" };
    renderShell();
    expect(screen.getByTitle("Share service unreachable")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-chip")).not.toBeInTheDocument();
  });
});
