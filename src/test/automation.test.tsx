import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("@/lib/share/client", () => ({
  getServiceUrl: async () => null,
  getSessionToken: async () => null,
  setServiceUrl: async () => {},
  register: async () => ({}),
  login: async () => ({}),
  logout: async () => {},
  onSessionStarted: () => () => {},
}));

import { AutomationPage } from "@/pages/Automation";

beforeAll(() => {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  localStorage.clear();
});
const renderPage = (tab?: string) =>
  render(
    <MemoryRouter
      initialEntries={[tab ? `/automation?tab=${tab}` : "/automation"]}
    >
      <AutomationPage />
    </MemoryRouter>,
  );
const open = (name: string) => {
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
};

describe("Automation page", () => {
  it("opens on the server and lists four tabs", () => {
    renderPage();
    const list = screen.getByRole("tablist", { name: "Automation sections" });
    for (const n of ["API server", "Try the API", "Phones", "Deep links"]) {
      expect(within(list).getByRole("tab", { name: n })).toBeInTheDocument();
    }
    expect(screen.getByRole("tab", { name: "API server" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Local API server")).toBeInTheDocument();
  });

  it("keeps each switch in one tab: start and stop only on the server", async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    try {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "get_api_status")
          return {
            running: false,
            address: "127.0.0.1",
            port: 17717,
            lan_access: false,
          };
        return null;
      });
      renderPage();
      expect(
        await screen.findByRole("button", { name: "Start Server" }),
      ).toBeInTheDocument();
      open("Try the API");
      expect(
        await screen.findByTestId("explorer-open-server"),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /start server|stop server/i }),
      ).not.toBeInTheDocument();
    } finally {
      (window as any).__TAURI_INTERNALS__ = undefined;
    }
  });

  it("jumps from the explorer to the server tab", async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    try {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "get_api_status")
          return {
            running: false,
            address: "127.0.0.1",
            port: 17717,
            lan_access: false,
          };
        return null;
      });
      renderPage("explorer");
      fireEvent.click(await screen.findByTestId("explorer-open-server"));
      expect(
        await screen.findByRole("button", { name: "Start Server" }),
      ).toBeInTheDocument();
    } finally {
      (window as any).__TAURI_INTERNALS__ = undefined;
    }
  });

  it("falls back to the server tab for an unknown ?tab=", () => {
    renderPage("nonsense");
    expect(screen.getByRole("tab", { name: "API server" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("groups deep-link trust under its own tab", async () => {
    renderPage("links");
    expect(
      await screen.findByText("Trusted deep-link sources"),
    ).toBeInTheDocument();
  });

  it("routes trusted sources through the dedicated command", async () => {
    // App mode: the backend answers, so the page must use the
    // get/set_trusted_sources commands (not the raw setting key).
    (window as any).__TAURI_INTERNALS__ = {};
    try {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "get_trusted_sources") return ["https://ok.example"];
        return null;
      });
      renderPage("links");
      expect(await screen.findByText("https://ok.example")).toBeInTheDocument();
      const box = screen.getByLabelText("Trusted source");
      fireEvent.change(box, { target: { value: "https://new.example" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("set_trusted_sources", {
          sources: ["https://ok.example", "https://new.example"],
        }),
      );
      // Never through the raw setting key.
      expect(
        invoke.mock.calls.some(
          (c) => c[0] === "set_setting" && c[1]?.key === "trusted_sources",
        ),
      ).toBe(false);
    } finally {
      (window as any).__TAURI_INTERNALS__ = undefined;
    }
  });
});

describe("Automation → Phones and server", () => {
  const appMode = () => {
    (window as any).__TAURI_INTERNALS__ = {};
  };
  const webMode = () => {
    (window as any).__TAURI_INTERNALS__ = undefined;
  };
  // The card shows one half per device: a PC offers itself, a phone
  // pairs. The platform is the user agent, as isAndroid() reads it.
  const asPhone = () =>
    vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile");
  const mockBackend = (
    impl: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
  ) => {
    invoke.mockImplementation(impl);
  };
  const openApi = (tab: "phones" | "server" = "phones") => {
    renderPage(tab);
  };
  const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);
  const savedSetting = (key: string) => {
    const matching = invoke.mock.calls.filter(
      (c) => c[0] === "set_setting" && (c[1] as { key?: string })?.key === key,
    );
    const call = matching[matching.length - 1];
    return call ? (call[1] as { value: string }).value : null;
  };
  const savedPairs = () => {
    const raw = savedSetting("render_pairs");
    return raw
      ? (JSON.parse(raw) as Array<{
          id: string;
          name: string;
          host: string;
          port: number;
          secret: string;
          fingerprint: string;
          provider_id: string;
          paired_at: string;
        }>)
      : null;
  };

  const PAIRING = {
    open: true,
    code: "K7QM4XPD",
    expires_in: 30,
    host: "192.168.1.9",
    port: 17717,
  };
  const CAPS = {
    protocol: 1,
    can_render: true,
    score: 800,
    cores: 8,
    platform: "linux",
    max_concurrent_renders: 2,
  };
  const CLAIMED_PAIR = {
    id: "provider-1",
    name: "Shop PC",
    host: "192.168.1.9",
    port: 17717,
    secret: "tokentokentokentokentokentoken01",
    fingerprint: "f".repeat(64),
    provider_id: "provider-1",
    platform: "windows",
    paired_at: new Date().toISOString(),
    device_id: "phone-1",
  };

  /** A PC backend with an in-memory device registry and pairing window. */
  const pcBackend = (opts: { enabled?: boolean; lan?: boolean } = {}) => {
    const state = {
      enabled: opts.enabled ?? false,
      lan: opts.lan ?? true,
      running: opts.lan ?? true,
      window: null as null | typeof PAIRING,
      devices: [] as Array<{
        id: string;
        name: string;
        display_name: string | null;
        platform: string;
        paired_at: string;
        last_seen_at: string;
        can_print: boolean;
        account_id: string | null;
        role: string;
        expires_at: string | null;
      }>,
      invites: [] as Array<{
        id: string;
        expires_at: string;
        uses_left: number | null;
        can_print: boolean;
        created_at: string;
        created_by: string | null;
      }>,
      inviteSeq: 0,
      failPairingOnce: false,
    };
    mockBackend(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "set_render_sharing":
          state.enabled = args?.["enabled"] === true;
          return "";
        case "get_render_status":
          return {
            enabled: state.enabled,
            secret_set: state.devices.length > 0,
            port: 17717,
            lan_access: state.lan,
            running: state.running,
            paired_count: state.devices.length,
          };
        case "get_api_status":
          return { running: state.running, port: 17717, lan_access: state.lan };
        case "stop_api_server":
          state.running = false;
          return null;
        case "start_api_server":
          state.running = true;
          state.lan = args?.["lan_access"] === true;
          return null;
        case "start_pairing":
          if (!state.enabled) throw new Error("render sharing is not enabled");
          if (state.failPairingOnce) {
            state.failPairingOnce = false;
            throw new Error("regeneration failed");
          }
          state.window = { ...PAIRING };
          return state.window;
        case "cancel_pairing":
          state.window = null;
          return null;
        case "get_pairing_state":
          return (
            state.window ?? {
              open: false,
              code: "",
              expires_in: 0,
              host: "192.168.1.9",
              port: 17717,
            }
          );
        case "list_paired_devices":
          return [...state.devices];
        case "revoke_paired_device": {
          const id = String(args?.["id"] ?? "");
          state.devices = state.devices.filter((d) => d.id !== id);
          return null;
        }
        case "clear_paired_devices": {
          const n = state.devices.length;
          state.devices = [];
          return n;
        }
        case "rename_paired_device": {
          const id = String(args?.["id"] ?? "");
          const name = String(args?.["name"] ?? "").trim();
          const row = state.devices.find((d) => d.id === id);
          if (!row) throw new Error("not found");
          row.display_name = name || null;
          return { ...row };
        }
        case "set_paired_can_print": {
          const id = String(args?.["id"] ?? "");
          const row = state.devices.find((d) => d.id === id);
          if (!row) throw new Error("not found");
          row.can_print = args?.["can_print"] === true;
          return { ...row };
        }
        case "create_pairing_invite": {
          state.inviteSeq += 1;
          const uses =
            args?.["max_uses"] == null ? null : Number(args?.["max_uses"]);
          const inv = {
            id: `inv-${state.inviteSeq}`,
            expires_at: new Date(
              Date.now() + Number(args?.["expires_in_hours"] ?? 24) * 3600000,
            ).toISOString(),
            uses_left: uses,
            can_print: args?.["can_print"] !== false,
            created_at: new Date().toISOString(),
            created_by: "user-1",
          };
          state.invites.push(inv);
          return { ...inv, code: "12345678" };
        }
        case "list_pairing_invites":
          return [...state.invites];
        case "revoke_pairing_invite": {
          const id = String(args?.["id"] ?? "");
          state.invites = state.invites.filter((v) => v.id !== id);
          return null;
        }
        default:
          return null;
      }
    });
    return state;
  };

  /** A phone backend: settings live in memory, so a saved pair shows up. */
  const phoneBackend = (
    opts: {
      pair?: unknown;
      pairError?: string;
      settings?: Record<string, string>;
    } = {},
  ) => {
    const settings: Record<string, string> = { ...opts.settings };
    mockBackend(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "get_setting":
          return settings[String(args?.["key"])] ?? null;
        case "set_setting":
          settings[String(args?.["key"])] = String(args?.["value"]);
          return null;
        case "pair_with_code":
          if (opts.pairError) throw new Error(opts.pairError);
          return opts.pair ?? CLAIMED_PAIR;
        case "peer_capabilities":
          return CAPS;
        default:
          return null;
      }
    });
    return settings;
  };

  describe("on a PC", () => {
    it("shows only the provider half, with no pair form", async () => {
      appMode();
      try {
        pcBackend();
        openApi();
        expect(await screen.findByTestId("devices-share-toggle")).toBeVisible();
        expect(screen.queryByTestId("devices-policy-toggle")).toBeNull();
        expect(screen.queryByTestId("devices-code-input")).toBeNull();
        expect(screen.queryByTestId("devices-code-submit")).toBeNull();
      } finally {
        webMode();
      }
    });

    it("turns sharing on without a hunt through the server settings", async () => {
      appMode();
      try {
        // Sharing off and the API server stopped: the old screen sent
        // the user to a LAN switch elsewhere. Now one toggle does it.
        // (Confirm seen: the dialog flow itself is covered above.)
        localStorage.setItem("printninja-share-confirm-seen", "true");
        pcBackend({ enabled: false, lan: false });
        openApi();
        fireEvent.click(await screen.findByTestId("devices-share-toggle"));
        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("set_render_sharing", {
            enabled: true,
          }),
        );
        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("start_api_server", {
            port: 17717,
            lan_access: true,
          }),
        );
        expect(savedSetting("api_lan_access")).toBe("true");
        expect(await screen.findByTestId("devices-pair-phone")).toBeVisible();
        // The warning is gone once Wi-Fi access is on.
        expect(screen.queryByTestId("devices-lan-enable")).toBeNull();
      } finally {
        webMode();
      }
    });

    it("restarts a loopback-only server for LAN instead of leaving two", async () => {
      appMode();
      try {
        pcBackend({ enabled: true, lan: false }).running = true;
        openApi();
        fireEvent.click(await screen.findByTestId("devices-lan-enable"));
        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("start_api_server", {
            port: 17717,
            lan_access: true,
          }),
        );
        const order = invoke.mock.calls.map((c) => c[0]);
        expect(order.indexOf("stop_api_server")).toBeGreaterThan(-1);
        expect(order.indexOf("stop_api_server")).toBeLessThan(
          order.lastIndexOf("start_api_server"),
        );
      } finally {
        webMode();
      }
    });

    it("offers a retry when Wi-Fi access cannot be switched on", async () => {
      appMode();
      try {
        mockBackend(async (cmd: string) => {
          if (cmd === "get_render_status")
            return {
              enabled: true,
              secret_set: true,
              port: 17717,
              lan_access: false,
              running: false,
            };
          if (cmd === "get_api_status")
            return { running: false, port: 17717, lan_access: false };
          if (cmd === "start_api_server") throw new Error("port in use");
          return null;
        });
        openApi();
        fireEvent.click(await screen.findByTestId("devices-lan-enable"));
        await waitFor(() => expect(calls("start_api_server")).toHaveLength(1));
        // Sharing stays on and the button stays for another try.
        expect(screen.getByTestId("devices-lan-enable")).toBeVisible();
        expect(savedSetting("api_lan_access")).toBeNull();
      } finally {
        webMode();
      }
    });

    it("opens a pairing window with a code, countdown and address", async () => {
      appMode();
      try {
        pcBackend({ enabled: true });
        openApi();
        const pairBtn = await screen.findByTestId("devices-pair-phone");
        expect(calls("start_pairing")).toHaveLength(0);

        fireEvent.click(pairBtn);
        expect(
          await screen.findByTestId("devices-pairing-code"),
        ).toHaveTextContent("K7QM4XPD");
        expect(
          screen.getByTestId("devices-pairing-countdown"),
        ).toHaveTextContent(/30/);
        expect(screen.getByTestId("devices-pairing-address")).toHaveTextContent(
          "192.168.1.9:17717",
        );
        expect(calls("start_pairing")).toHaveLength(1);

        // Closing the panel drops the code from the page again.
        fireEvent.click(screen.getByTestId("devices-pair-phone-hide"));
        await waitFor(() =>
          expect(screen.queryByTestId("devices-pairing-code")).toBeNull(),
        );
        expect(calls("cancel_pairing")).toHaveLength(1);
      } finally {
        webMode();
      }
    });

    it("mints a new code on demand", async () => {
      appMode();
      try {
        pcBackend({ enabled: true });
        openApi();
        fireEvent.click(await screen.findByTestId("devices-pair-phone"));
        await screen.findByTestId("devices-pairing-code");
        fireEvent.click(screen.getByTestId("devices-new-code"));
        await waitFor(() => expect(calls("start_pairing")).toHaveLength(2));
      } finally {
        webMode();
      }
    });

    it("offers a new code after the window lapses with no pairing", async () => {
      // Regression: the expired branch used to show "get a new one" with
      // no button to get one — the only recovery was closing the panel.
      appMode();
      try {
        const be = pcBackend({ enabled: true });
        openApi();
        fireEvent.click(await screen.findByTestId("devices-pair-phone"));
        await screen.findByTestId("devices-pairing-code");
        // The window lapses unclaimed and the automatic replacement
        // fails, so the panel lands on the expired state.
        be.failPairingOnce = true;
        be.window = null;
        await waitFor(() =>
          expect(screen.queryByTestId("devices-pairing-code")).toBeNull(),
        );
        fireEvent.click(await screen.findByTestId("devices-new-code"));
        await screen.findByTestId("devices-pairing-code");
      } finally {
        webMode();
      }
    });

    it("shows a newly paired phone without leaving the page", async () => {
      // Regression: the list only refreshed on mount/focus, so a guest
      // pairing from its own screen sat invisible until navigation.
      // Real timers: the poll interval is scheduled at mount, and fake
      // timers installed afterwards cannot move it.
      appMode();
      try {
        const be = pcBackend({ enabled: true });
        openApi();
        renderPage();
        await screen.findByTestId("devices-share-toggle");
        expect(screen.queryByTestId("devices-paired-guest-1")).toBeNull();
        be.devices.push({
          id: "guest-1",
          name: "Guest Phone",
          display_name: null,
          platform: "android",
          paired_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          can_print: true,
          account_id: null,
          role: "guest",
          expires_at: null,
        });
        expect(
          await screen.findByTestId("devices-paired-guest-1", undefined, {
            timeout: 8000,
          }),
        ).toHaveTextContent("Guest Phone");
      } finally {
        webMode();
      }
    }, 15000);

    it("asks before removing all phones, and cancel changes nothing", async () => {
      appMode();
      try {
        const be = pcBackend({ enabled: true });
        be.devices = [
          {
            id: "p1",
            name: "Phone",
            display_name: null,
            platform: "android",
            paired_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            can_print: true,
            account_id: "user-1",
            role: "owner",
            expires_at: null,
          },
        ];
        openApi();
        expect(await screen.findByTestId("devices-paired-p1")).toBeVisible();
        fireEvent.click(screen.getByTestId("devices-clear-all"));
        expect(await screen.findByRole("alert")).toHaveTextContent(
          /until it pairs again/i,
        );
        expect(calls("clear_paired_devices")).toHaveLength(0);
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByTestId("devices-clear-confirm")).toBeNull();
        expect(calls("clear_paired_devices")).toHaveLength(0);
      } finally {
        webMode();
      }
    });

    it("removes all phones and refreshes the list", async () => {
      appMode();
      try {
        const be = pcBackend({ enabled: true });
        be.devices = [
          {
            id: "p1",
            name: "Phone",
            display_name: null,
            platform: "android",
            paired_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            can_print: true,
            account_id: "user-1",
            role: "owner",
            expires_at: null,
          },
        ];
        openApi();
        await screen.findByTestId("devices-paired-p1");

        fireEvent.click(screen.getByTestId("devices-clear-all"));
        fireEvent.click(await screen.findByTestId("devices-clear-confirm"));
        await waitFor(() =>
          expect(calls("clear_paired_devices")).toHaveLength(1),
        );
        await waitFor(() =>
          expect(screen.queryByTestId("devices-paired-p1")).toBeNull(),
        );
      } finally {
        webMode();
      }
    });

    it("renames a phone and removes one phone with confirmation", async () => {
      appMode();
      try {
        const be = pcBackend({ enabled: true });
        be.devices = [
          {
            id: "p1",
            name: "Android phone",
            display_name: null,
            platform: "android",
            paired_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            can_print: true,
            account_id: "user-1",
            role: "owner",
            expires_at: null,
          },
        ];
        openApi();
        await screen.findByText("Android phone");

        fireEvent.click(screen.getByTestId("devices-rename-p1"));
        fireEvent.change(screen.getByTestId("devices-rename-input-p1"), {
          target: { value: "Shop Phone" },
        });
        fireEvent.click(screen.getByTestId("devices-rename-save-p1"));
        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("rename_paired_device", {
            id: "p1",
            name: "Shop Phone",
          }),
        );
        expect(await screen.findByText("Shop Phone")).toBeVisible();

        fireEvent.click(screen.getByTestId("devices-remove-p1"));
        fireEvent.click(await screen.findByTestId("devices-remove-confirm-p1"));
        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("revoke_paired_device", {
            id: "p1",
          }),
        );
        await waitFor(() =>
          expect(screen.queryByTestId("devices-paired-p1")).toBeNull(),
        );
      } finally {
        webMode();
      }
    });

    it("toggles printing for one phone without touching the others", async () => {
      appMode();
      try {
        const be = pcBackend({ enabled: true });
        be.devices = [
          {
            id: "p1",
            name: "Android phone",
            display_name: null,
            platform: "android",
            paired_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            can_print: true,
            account_id: "user-1",
            role: "owner",
            expires_at: null,
          },
        ];
        openApi();
        await screen.findByText("Android phone");
        // The account badge renders from the stored row (ARCHITECTURE §9); no local
        // account here, so it reads as different.
        expect(
          await screen.findByTestId("devices-account-p1"),
        ).toHaveTextContent(/Different account/);
        const toggle = await screen.findByTestId("devices-can-print-p1");
        expect(toggle).toHaveAttribute("aria-checked", "true");
        fireEvent.click(toggle);
        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("set_paired_can_print", {
            id: "p1",
            can_print: false,
          }),
        );
        await waitFor(() =>
          expect(screen.getByTestId("devices-can-print-p1")).toHaveAttribute(
            "aria-checked",
            "false",
          ),
        );
      } finally {
        webMode();
      }
    });

    it("mints a guest invite, shows the code once, and revokes it", async () => {
      appMode();
      try {
        pcBackend({ enabled: true });
        openApi();
        fireEvent.click(await screen.findByTestId("devices-invite"));
        fireEvent.click(screen.getByTestId("devices-invite-mint"));
        expect(
          await screen.findByTestId("devices-invite-code"),
        ).toHaveTextContent("12345678");
        expect(
          await screen.findByTestId("devices-invite-inv-1"),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByTestId("devices-invite-revoke-inv-1"));
        await waitFor(() =>
          expect(screen.queryByTestId("devices-invite-inv-1")).toBeNull(),
        );
      } finally {
        webMode();
      }
    });

    it("badges guest phones", async () => {
      appMode();
      try {
        const be = pcBackend({ enabled: true });
        be.devices = [
          {
            id: "g1",
            name: "Guest Phone",
            display_name: null,
            platform: "android",
            paired_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            can_print: true,
            account_id: null,
            role: "guest",
            expires_at: "2030-01-01T00:00:00Z",
          },
        ];
        openApi();
        expect(await screen.findByTestId("devices-role-g1")).toHaveTextContent(
          "Guest",
        );
      } finally {
        webMode();
      }
    });

    it("turning sharing off closes the pairing panel", async () => {
      appMode();
      try {
        pcBackend({ enabled: true });
        openApi();
        fireEvent.click(await screen.findByTestId("devices-pair-phone"));
        await screen.findByTestId("devices-pairing-code");
        fireEvent.click(screen.getByTestId("devices-share-toggle"));
        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("set_render_sharing", {
            enabled: false,
          }),
        );
        // Sharing off means loopback-only: the bind follows, so a
        // stopped-then-started server listens locally.
        await waitFor(() =>
          expect(savedSetting("api_lan_access")).toBe("false"),
        );
        await waitFor(() =>
          expect(screen.queryByTestId("devices-pairing-code")).toBeNull(),
        );
        expect(screen.queryByTestId("devices-pair-phone")).toBeNull();
      } finally {
        webMode();
      }
    });
  });

  describe("share switch (one switch, on the phones tab)", () => {
    const shareToggle = () => screen.findByTestId("devices-share-toggle");

    it("writes both keys and warns on first enable after confirm", async () => {
      appMode();
      try {
        pcBackend({ enabled: false, lan: false });
        openApi();
        const toggle = await screen.findByTestId("devices-share-toggle");
        expect(toggle).not.toBeChecked();
        fireEvent.click(toggle);
        // First enable asks once.
        fireEvent.click(await screen.findByRole("button", { name: "Share" }));
        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("set_render_sharing", {
            enabled: true,
          }),
        );
        await waitFor(() =>
          expect(savedSetting("api_lan_access")).toBe("true"),
        );
        // The phones tab offers pairing once sharing is live.
        expect(await screen.findByTestId("devices-pair-phone")).toBeVisible();
        expect(screen.queryByTestId("devices-lan-enable")).toBeNull();
      } finally {
        webMode();
      }
    });

    it("skips the confirm once seen", async () => {
      appMode();
      try {
        localStorage.setItem("printninja-share-confirm-seen", "true");
        pcBackend({ enabled: false, lan: false });
        openApi();
        fireEvent.click(await shareToggle());
        expect(screen.queryByRole("dialog")).toBeNull();
        await waitFor(() =>
          expect(savedSetting("api_lan_access")).toBe("true"),
        );
        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("set_render_sharing", {
            enabled: true,
          }),
        );
      } finally {
        webMode();
      }
    });

    it("cancelling the confirm leaves sharing off", async () => {
      appMode();
      try {
        openApi();
        fireEvent.click(await shareToggle());
        fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(
          invoke.mock.calls.some((c) => c[0] === "set_render_sharing"),
        ).toBe(false);
        expect(savedSetting("api_lan_access")).toBeNull();
      } finally {
        webMode();
      }
    });

    it("keeps the port visible and shows LAN access under Network access", async () => {
      appMode();
      try {
        openApi("server");
        // Port stays a primary start parameter...
        expect(await screen.findByTestId("settings-api-port")).toBeVisible();
        // ...while the stopped status names no bind address anymore
        // (the curl example below legitimately keeps its loopback URL).
        expect(await screen.findByText("Port 17717")).toBeVisible();
        expect(screen.queryByText(/0\.0\.0\.0/)).toBeNull();
        // LAN access is a plain switch under "Network access", not
        // tucked into a collapsed section.
        expect(await screen.findByText("Network access")).toBeVisible();
        const lan = await screen.findByRole("switch", {
          name: "Allow LAN access",
        });
        expect(lan).toBeVisible();
        expect(lan.closest("details")).toBeNull();
        expect(screen.queryByText("Advanced")).toBeNull();
      } finally {
        webMode();
      }
    });
  });

  describe("sharing state on a PC", () => {
    it("shows sharing off when the server is stopped", async () => {
      appMode();
      try {
        const be = pcBackend({ enabled: true, lan: true });
        be.running = false;
        openApi();
        const toggle = await screen.findByTestId("devices-share-toggle");
        await waitFor(() => expect(toggle).not.toBeChecked());
        expect(screen.queryByTestId("devices-pair-phone")).toBeNull();
        expect(screen.getByTestId("devices-lan-enable")).toBeVisible();
      } finally {
        webMode();
      }
    });

    it("shows sharing off when LAN access is off", async () => {
      appMode();
      try {
        pcBackend({ enabled: true, lan: false }).running = true;
        openApi();
        const toggle = await screen.findByTestId("devices-share-toggle");
        await waitFor(() => expect(toggle).not.toBeChecked());
        expect(screen.queryByTestId("devices-pair-phone")).toBeNull();
      } finally {
        webMode();
      }
    });

    it("shows sharing on when the server runs with LAN access", async () => {
      appMode();
      try {
        pcBackend({ enabled: true, lan: true });
        openApi();
        const toggle = await screen.findByTestId("devices-share-toggle");
        await waitFor(() => expect(toggle).toBeChecked());
        expect(screen.getByTestId("devices-pair-phone")).toBeVisible();
      } finally {
        webMode();
      }
    });

    it("never claims a pinned background notification on a PC", async () => {
      appMode();
      try {
        pcBackend({ enabled: true, lan: true }).running = true;
        openApi("server");
        await screen.findByText("Local API server");
        expect(screen.queryByTestId("settings-api-background")).toBeNull();
      } finally {
        webMode();
      }
    });
  });

  describe("on a phone", () => {
    let ua: ReturnType<typeof asPhone>;
    beforeEach(() => {
      ua = asPhone();
    });
    afterEach(() => ua.mockRestore());

    it("shows only the consumer half, with the code entry up front", async () => {
      appMode();
      try {
        phoneBackend();
        openApi();
        expect(await screen.findByTestId("devices-code-input")).toBeVisible();
        expect(screen.getByTestId("devices-code-submit")).toBeVisible();
        expect(screen.queryByTestId("devices-share-toggle")).toBeNull();
        expect(screen.getByText(/No PC paired yet/)).toBeInTheDocument();
        // The manual address is tucked away until asked for.
        expect(screen.getByTestId("devices-advanced")).not.toHaveAttribute(
          "open",
        );
      } finally {
        webMode();
      }
    });

    it("says the running server also survives in the background", async () => {
      appMode();
      try {
        // The whole point on Android: the notification is what tells the
        // user the server outlives the app.
        mockBackend(async (cmd: string) => {
          if (cmd === "get_api_status")
            return {
              running: true,
              address: "127.0.0.1",
              port: 17717,
              lan_access: false,
            };
          if (cmd === "get_render_status")
            return {
              enabled: false,
              secret_set: false,
              port: 17717,
              lan_access: false,
              running: true,
              paired_count: 0,
            };
          return null;
        });
        openApi("server");
        expect(
          await screen.findByTestId("settings-api-background"),
        ).toBeVisible();
      } finally {
        webMode();
      }
    });

    it("normalizes the code as typed and enables Pair when complete", async () => {
      appMode();
      try {
        phoneBackend();
        openApi();
        const input = await screen.findByTestId("devices-code-input");
        const submit = screen.getByTestId("devices-code-submit");
        expect(submit).toBeDisabled();
        // Lowercase, dashes and spaces are accepted; other characters
        // never reach the field. Displayed uppercased with no hyphen.
        fireEvent.change(input, { target: { value: "k7qm-4xpd!!01" } });
        expect(input).toHaveValue("K7QM4XPD");
        expect(submit).toBeEnabled();
      } finally {
        webMode();
      }
    });

    it("pairs from a typed code and tests it at once", async () => {
      appMode();
      try {
        phoneBackend();
        openApi();
        fireEvent.change(await screen.findByTestId("devices-code-input"), {
          target: { value: "k7qm-4xpd" },
        });
        fireEvent.click(screen.getByTestId("devices-code-submit"));

        await waitFor(() => expect(savedPairs()).toHaveLength(1));
        expect(savedPairs()![0]).toMatchObject({
          name: "Shop PC",
          host: "192.168.1.9",
          port: 17717,
          provider_id: "provider-1",
        });
        expect(invoke).toHaveBeenCalledWith(
          "pair_with_code",
          expect.objectContaining({ code: "K7QM4XPD" }),
        );
        // A bad code shows up now, not at the first print.
        expect(await screen.findByText(/Score 800/)).toBeInTheDocument();
        expect(invoke).toHaveBeenCalledWith(
          "peer_capabilities",
          expect.objectContaining({
            host: "192.168.1.9",
            port: 17717,
          }),
        );
        // A phone always uses its PC: there is no policy to switch on.
        expect(savedSetting("render_policy")).toBeNull();
        // The field clears once it has done its job.
        expect(screen.getByTestId("devices-code-input")).toHaveValue("");
      } finally {
        webMode();
      }
    });

    it("pairs a second PC without touching the stored policy", async () => {
      appMode();
      try {
        const existing = JSON.stringify([
          {
            id: "old-provider",
            name: "Old PC",
            host: "192.168.1.5",
            port: 17717,
            secret: "x",
            fingerprint: "",
            provider_id: "old-provider",
          },
        ]);
        phoneBackend({
          settings: { render_pairs: existing, render_policy: "local" },
        });
        openApi();
        fireEvent.change(await screen.findByTestId("devices-code-input"), {
          target: { value: "K7QM4XPD" },
        });
        fireEvent.click(screen.getByTestId("devices-code-submit"));
        await waitFor(() => expect(savedPairs()).toHaveLength(2));
        expect(savedSetting("render_policy")).toBeNull();
      } finally {
        webMode();
      }
    });

    it("re-pairing the same PC replaces its pair instead of duplicating", async () => {
      appMode();
      try {
        const existing = JSON.stringify([
          {
            id: "provider-1",
            name: "Shop PC",
            host: "192.168.1.9",
            port: 17717,
            secret: "old",
            fingerprint: "",
            provider_id: "provider-1",
          },
        ]);
        phoneBackend({
          settings: { render_pairs: existing, render_policy: "auto" },
        });
        openApi();
        await screen.findByText("Shop PC");
        fireEvent.change(screen.getByTestId("devices-code-input"), {
          target: { value: "K7QM4XPD" },
        });
        fireEvent.click(screen.getByTestId("devices-code-submit"));
        await waitFor(() => expect(savedPairs()).toHaveLength(1));
        // After the PC removed the phone, pairing again swaps the token in.
        expect(savedPairs()![0]).toMatchObject({
          host: "192.168.1.9",
          provider_id: "provider-1",
        });
      } finally {
        webMode();
      }
    });

    it("refuses an incomplete code without asking the backend", async () => {
      appMode();
      try {
        phoneBackend();
        openApi();
        // Only alphabet characters land in the field; "short" loses its O.
        fireEvent.change(await screen.findByTestId("devices-code-input"), {
          target: { value: "short" },
        });
        expect(screen.getByTestId("devices-code-input")).toHaveValue("SHRT");
        expect(screen.getByTestId("devices-code-submit")).toBeDisabled();
        expect(calls("pair_with_code")).toHaveLength(0);
        expect(savedPairs()).toBeNull();
      } finally {
        webMode();
      }
    });

    it("shows the backend's reason on a wrong code", async () => {
      appMode();
      try {
        phoneBackend({
          pairError: "Wrong code (4 tries left). Check the PC and try again.",
        });
        openApi();
        fireEvent.change(await screen.findByTestId("devices-code-input"), {
          target: { value: "AAAAAAAA" },
        });
        fireEvent.click(screen.getByTestId("devices-code-submit"));
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "Wrong code",
        );
        // Nothing was saved.
        expect(savedPairs()).toBeNull();
        expect(calls("peer_capabilities")).toHaveLength(0);
      } finally {
        webMode();
      }
    });

    it("pairs through a typed address when the search finds nothing", async () => {
      appMode();
      try {
        phoneBackend();
        openApi();
        fireEvent.change(await screen.findByTestId("devices-code-input"), {
          target: { value: "K7QM4XPD" },
        });
        fireEvent.change(screen.getByTestId("devices-addr-input"), {
          target: { value: "192.168.1.20:17717" },
        });
        fireEvent.click(screen.getByTestId("devices-code-submit"));
        await waitFor(() => expect(savedPairs()).toHaveLength(1));
        expect(invoke).toHaveBeenCalledWith(
          "pair_with_code",
          expect.objectContaining({
            code: "K7QM4XPD",
            host: "192.168.1.20:17717",
          }),
        );
      } finally {
        webMode();
      }
    });

    it("tests and removes a pair", async () => {
      appMode();
      try {
        const existing = JSON.stringify([
          {
            id: "provider-1",
            name: "Shop PC",
            host: "192.168.1.9",
            port: 17717,
            secret: "tokentokentokentokentokentoken01",
            fingerprint: "",
            provider_id: "provider-1",
          },
        ]);
        phoneBackend({
          settings: { render_pairs: existing, render_policy: "auto" },
        });
        openApi();
        await screen.findByText("Shop PC");

        fireEvent.click(screen.getByTestId("devices-pair-test-provider-1"));
        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith(
            "peer_capabilities",
            expect.objectContaining({
              host: "192.168.1.9",
              port: 17717,
            }),
          ),
        );
        expect(await screen.findByText(/Score 800/)).toBeInTheDocument();

        fireEvent.click(screen.getByTestId("devices-pair-remove-provider-1"));
        await waitFor(() => expect(savedPairs()).toEqual([]));
      } finally {
        webMode();
      }
    });

    it("collapses duplicate pairs to the newest with one tap", async () => {
      appMode();
      try {
        const dupes = JSON.stringify([
          {
            id: "old",
            name: "Shop PC",
            host: "192.168.1.9",
            port: 17717,
            secret: "old-secret",
            fingerprint: "",
            provider_id: "old-id",
            paired_at: "2026-01-01T00:00:00Z",
          },
          {
            id: "new",
            name: "Shop PC",
            host: "192.168.1.9",
            port: 17717,
            secret: "new-secret",
            fingerprint: "",
            provider_id: "new-id",
            paired_at: "2026-02-01T00:00:00Z",
          },
        ]);
        phoneBackend({ settings: { render_pairs: dupes } });
        openApi();
        await screen.findByTestId("devices-pair-old");
        await screen.findByTestId("devices-pair-new");
        fireEvent.click(await screen.findByTestId("devices-dedupe"));
        await waitFor(() => {
          const kept = savedPairs();
          expect(kept).toHaveLength(1);
          expect(kept![0].provider_id).toBe("new-id");
        });
        expect(screen.queryByTestId("devices-dedupe")).toBeNull();
      } finally {
        webMode();
      }
    });

    it("hides the share switch on a phone, server tab included", async () => {
      appMode();
      try {
        phoneBackend();
        openApi("server");
        // The panel itself renders (Start button proves it); the switch
        // must not — sharing is a PC offer, not a phone one.
        await screen.findByRole("button", { name: "Start Server" });
        expect(screen.queryByTestId("settings-share-paired")).toBeNull();
      } finally {
        webMode();
      }
    });

    it("calls the pairs tab PC on a phone", async () => {
      appMode();
      try {
        phoneBackend();
        openApi();
        expect(
          await screen.findByRole("tab", { name: "PC" }),
        ).toBeInTheDocument();
        expect(screen.queryByRole("tab", { name: "Phones" })).toBeNull();
      } finally {
        webMode();
      }
    });

    it("shows the failure on the row when the PC cannot be reached", async () => {
      appMode();
      try {
        const existing = JSON.stringify([
          {
            id: "provider-1",
            name: "Shop PC",
            host: "192.168.1.9",
            port: 17717,
            secret: "tokentokentokentokentokentoken01",
            fingerprint: "",
            provider_id: "provider-1",
          },
        ]);
        mockBackend(async (cmd: string, args?: Record<string, unknown>) => {
          if (cmd === "get_setting")
            return args?.["key"] === "render_pairs" ? existing : null;
          if (cmd === "peer_capabilities")
            throw new Error("Shop PC is unreachable");
          return null;
        });
        openApi();
        await screen.findByText("Shop PC");
        fireEvent.click(screen.getByTestId("devices-pair-test-provider-1"));
        // An unreachable known pair reads as an address change with a
        // Pair again button, not the raw probe text.
        expect(await screen.findByRole("alert")).toHaveTextContent(
          /address changed/i,
        );
        expect(
          screen.getByTestId("devices-pair-again-provider-1"),
        ).toBeVisible();
      } finally {
        webMode();
      }
    });

    it("says the PC removed this phone and offers to pair again", async () => {
      appMode();
      try {
        const existing = JSON.stringify([
          {
            id: "provider-1",
            name: "Shop PC",
            host: "192.168.1.9",
            port: 17717,
            secret: "tokentokentokentokentokentoken01",
            fingerprint: "",
            provider_id: "provider-1",
          },
        ]);
        mockBackend(async (cmd: string, args?: Record<string, unknown>) => {
          if (cmd === "get_setting")
            return args?.["key"] === "render_pairs" ? existing : null;
          if (cmd === "peer_capabilities")
            throw new Error("Shop PC removed this phone. Pair again.");
          return null;
        });
        openApi();
        await screen.findByText("Shop PC");
        fireEvent.click(screen.getByTestId("devices-pair-test-provider-1"));
        expect(await screen.findByRole("alert")).toHaveTextContent(
          /removed this phone/i,
        );
        expect(
          screen.getByTestId("devices-pair-again-provider-1"),
        ).toBeVisible();
      } finally {
        webMode();
      }
    });

    it("says the address changed when a known pair goes silent", async () => {
      appMode();
      try {
        const existing = JSON.stringify([
          {
            id: "provider-1",
            name: "Shop PC",
            host: "192.168.1.9",
            port: 17717,
            secret: "tokentokentokentokentokentoken01",
            fingerprint: "",
            provider_id: "provider-1",
          },
        ]);
        mockBackend(async (cmd: string, args?: Record<string, unknown>) => {
          if (cmd === "get_setting")
            return args?.["key"] === "render_pairs" ? existing : null;
          if (cmd === "peer_capabilities")
            throw new Error(
              "Shop PC is blocked or unreachable (no answer on port 17717). Check that the PC is on.",
            );
          return null;
        });
        openApi();
        await screen.findByText("Shop PC");
        fireEvent.click(screen.getByTestId("devices-pair-test-provider-1"));
        expect(await screen.findByRole("alert")).toHaveTextContent(
          /address changed/i,
        );
        expect(
          screen.getByTestId("devices-pair-again-provider-1"),
        ).toBeVisible();
      } finally {
        webMode();
      }
    });

    it("has no switch to stop using the PC", async () => {
      appMode();
      try {
        const existing = JSON.stringify([
          {
            id: "provider-1",
            name: "Shop PC",
            host: "192.168.1.9",
            port: 17717,
            secret: "tokentokentokentokentokentoken01",
            fingerprint: "",
            provider_id: "provider-1",
          },
        ]);
        phoneBackend({
          settings: { render_pairs: existing, render_policy: "local" },
        });
        openApi();
        expect(await screen.findByText("Shop PC")).toBeInTheDocument();
        // Android always renders through its PC, so there is nothing to
        // turn off here (the pairing itself is removed with the bin).
        expect(screen.queryByTestId("devices-policy-toggle")).toBeNull();
        expect(screen.queryByText("Use my PC to make PDFs")).toBeNull();
      } finally {
        webMode();
      }
    });
  });

  it("explains that the browser preview cannot share renders", async () => {
    webMode();
    renderPage("phones");
    expect(
      await screen.findByText(/browser preview does not have/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("devices-share-toggle")).toBeNull();
    expect(screen.queryByTestId("devices-code-input")).toBeNull();
  });
});
