import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import "@/lib/i18n";
import { Layout } from "@/components/Layout";
import { notifyApiStatusChanged } from "@/lib/apiServer";
import { settingsLsKey, writeSetting } from "@/lib/settings";

const mockAgent = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agent/commands", () => ({
  agent: (...args: unknown[]) => mockAgent(...args),
}));
vi.mock("@/lib/shell/useShareStatus", () => ({
  useShareStatus: () => ({ state: "unconfigured" }),
}));
vi.mock("@/lib/sync/useSyncStatus", () => ({
  useSyncStatus: () => ({
    state: "synced",
    drafts: 0,
    lastPulledAt: null,
    lastError: null,
  }),
  cacheNow: vi.fn(async () => {}),
}));
vi.mock("@/lib/prefs/PrefsProvider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/prefs/PrefsProvider")>();
  return {
    ...actual,
    usePrefs: () => ({ appName: "PrintNinja", logo: undefined }),
  };
});

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/history"]}>
      <Layout>
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </Layout>
    </MemoryRouter>,
  );
}

/** Mutable fake backend: the tests flip fields and nudge the shell. */
const be = {
  api: {
    running: false,
    address: "127.0.0.1",
    port: 17717,
    lan_access: false,
  } as unknown,
  apiFails: 0,
  render: { enabled: false, running: false, lan_access: false } as unknown,
};

beforeEach(() => {
  localStorage.clear();
  be.api = {
    running: false,
    address: "127.0.0.1",
    port: 17717,
    lan_access: false,
  };
  be.apiFails = 0;
  be.render = { enabled: false, running: false, lan_access: false };
  mockAgent.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd === "get_api_status") {
      if (be.apiFails > 0) {
        be.apiFails -= 1;
        throw new Error("transient");
      }
      return be.api;
    }
    if (cmd === "get_render_status") return be.render;
    throw new Error("no backend");
  });
});

afterEach(() => localStorage.clear());

const lanUp = {
  running: true,
  address: "0.0.0.0",
  port: 17717,
  lan_access: true,
};

describe("top-bar badges for switches that change behaviour", () => {
  it("shows Sharing only while phones can actually reach this PC", async () => {
    be.api = lanUp;
    be.render = { enabled: true, running: true, lan_access: true };
    renderShell();
    const link = await screen.findByTestId("sharing-indicator");
    expect(link).toHaveAttribute("href", "/automation?tab=phones");
    expect(link).toHaveAccessibleName(/shared with phones/i);
  });

  it("hides Sharing when it is enabled but the server is stopped", async () => {
    be.render = { enabled: true, running: false, lan_access: true };
    renderShell();
    await waitFor(() =>
      expect(mockAgent).toHaveBeenCalledWith("get_render_status", {}),
    );
    expect(screen.queryByTestId("sharing-indicator")).toBeNull();
  });

  it("shows Via PC and updates the phone bar the moment the setting changes", async () => {
    renderShell();
    const nav = () =>
      document.querySelector('[data-slot="mobile-nav"]') as HTMLElement;
    await waitFor(() =>
      expect(within(nav()).getByText("Printers")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("via-pc-indicator")).toBeNull();

    // Same route: only the setting write tells the shell.
    await act(async () => {
      await writeSetting("print_via_pc", "true");
    });
    const badge = await screen.findByTestId("via-pc-indicator");
    expect(badge).toHaveAttribute("href", "/automation?tab=phones");
    await waitFor(() =>
      expect(within(nav()).queryByText("Printers")).toBeNull(),
    );

    await act(async () => {
      await writeSetting("print_via_pc", "false");
    });
    await waitFor(() =>
      expect(screen.queryByTestId("via-pc-indicator")).toBeNull(),
    );
    expect(within(nav()).getByText("Printers")).toBeInTheDocument();
  });

  it("warns when private-IP blocking is switched off, and only then", async () => {
    renderShell();
    await waitFor(() => expect(mockAgent).toHaveBeenCalled());
    // Nothing saved means the default (blocked): no warning.
    expect(screen.queryByTestId("private-open-indicator")).toBeNull();

    await act(async () => {
      await writeSetting("block_private_ips", "false");
    });
    const warn = await screen.findByTestId("private-open-indicator");
    expect(warn).toHaveAttribute(
      "href",
      "/settings?section=data&field=block-private",
    );

    await act(async () => {
      await writeSetting("block_private_ips", "true");
    });
    await waitFor(() =>
      expect(screen.queryByTestId("private-open-indicator")).toBeNull(),
    );
  });

  it("reads a saved setting on first paint", async () => {
    localStorage.setItem(settingsLsKey("block_private_ips"), "false");
    renderShell();
    expect(
      await screen.findByTestId("private-open-indicator"),
    ).toBeInTheDocument();
  });

  it("keeps the LAN alert through a one-off read failure", async () => {
    be.api = lanUp;
    renderShell();
    await screen.findByTestId("lan-indicator");

    be.apiFails = 2;
    act(() => notifyApiStatusChanged());
    act(() => notifyApiStatusChanged());
    await waitFor(() => expect(be.apiFails).toBe(0));
    expect(screen.getByTestId("lan-indicator")).toBeInTheDocument();
  });

  it("drops the badge once the status stays unreadable", async () => {
    be.api = lanUp;
    renderShell();
    await screen.findByTestId("lan-indicator");

    be.apiFails = 99;
    for (let i = 0; i < 3; i++) {
      await act(async () => notifyApiStatusChanged());
    }
    await waitFor(() =>
      expect(screen.queryByTestId("lan-indicator")).toBeNull(),
    );
  });

  it("renders the API and LAN badges compact: icon at every width, word from sm up", async () => {
    be.api = lanUp;
    renderShell();
    const lan = await screen.findByTestId("lan-indicator");
    const word = within(lan).getByText("LAN access is on");
    expect(word).toHaveClass("hidden", "sm:inline");
    fireEvent.click(lan);
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent("/automation"),
    );
  });
});
