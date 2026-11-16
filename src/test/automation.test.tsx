import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
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
// Hoisted: the appUpdate mock factory runs before this file's consts
// exist, so the mock function must be created even earlier.
const { openExternalUrlMock } = vi.hoisted(() => ({
  openExternalUrlMock: vi.fn(),
}));
const serviceUrl: { value: string | null } = { value: null };
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("@/lib/appUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/appUpdate")>()),
  openExternalUrl: openExternalUrlMock,
}));
vi.mock("@/lib/share/client", () => ({
  getServiceUrl: async () => serviceUrl.value,
  getSessionToken: async () => null,
  setServiceUrl: async () => {},
  register: async () => ({}),
  login: async () => ({}),
  logout: async () => {},
  onSessionStarted: () => () => {},
  onSessionEnded: () => () => {},
  getWelcomeName: () => null,
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
  openExternalUrlMock.mockReset();
  serviceUrl.value = null;
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
// The platform is the user agent, as isAndroid() reads it.
const asPhone = () =>
  vi
    .spyOn(window.navigator, "userAgent", "get")
    .mockReturnValue("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile");

describe("Automation page", () => {
  it("opens on the server and lists three tabs", () => {
    renderPage();
    const list = screen.getByRole("tablist", { name: "Automation sections" });
    for (const n of ["API server", "Try the API", "Deep links"]) {
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

  it("keeps the port visible and shows LAN access under Network access", async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    try {
      renderPage("server");
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
      (window as any).__TAURI_INTERNALS__ = undefined;
    }
  });

  it("never claims a pinned background notification on a PC", async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    try {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "get_api_status")
          return { running: true, port: 17717, lan_access: true };
        if (cmd === "get_render_status")
          return {
            enabled: true,
            secret_set: true,
            port: 17717,
            lan_access: true,
            running: true,
            paired_count: 1,
          };
        return null;
      });
      renderPage("server");
      await screen.findByText("Local API server");
      expect(screen.queryByTestId("settings-api-background")).toBeNull();
    } finally {
      (window as any).__TAURI_INTERNALS__ = undefined;
    }
  });

  it("says the running server also survives in the background on a phone", async () => {
    const ua = asPhone();
    (window as any).__TAURI_INTERNALS__ = {};
    try {
      // The whole point on Android: the notification is what tells the
      // user the server outlives the app.
      invoke.mockImplementation(async (cmd: string) => {
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
      renderPage("server");
      expect(
        await screen.findByTestId("settings-api-background"),
      ).toBeVisible();
    } finally {
      (window as any).__TAURI_INTERNALS__ = undefined;
      ua.mockRestore();
    }
  });

  it("hides the share switch on a phone, server tab included", async () => {
    const ua = asPhone();
    (window as any).__TAURI_INTERNALS__ = {};
    try {
      renderPage("server");
      // The panel itself renders (Start button proves it); the switch
      // must not — sharing is a PC offer, not a phone one.
      await screen.findByRole("button", { name: "Start Server" });
      expect(screen.queryByTestId("settings-share-paired")).toBeNull();
    } finally {
      (window as any).__TAURI_INTERNALS__ = undefined;
      ua.mockRestore();
    }
  });

  describe("demo page button (server tab)", () => {
    it("opens the share service demo page while the server runs", async () => {
      (window as any).__TAURI_INTERNALS__ = {};
      try {
        serviceUrl.value = "https://share.example";
        invoke.mockImplementation(async (cmd: string) => {
          if (cmd === "get_api_status")
            return { running: true, port: 17717, lan_access: true };
          return null;
        });
        renderPage("server");
        fireEvent.click(await screen.findByTestId("automation-open-demo"));
        await waitFor(() =>
          expect(openExternalUrlMock).toHaveBeenCalledWith(
            "https://share.example/demo/print.html",
          ),
        );
      } finally {
        (window as any).__TAURI_INTERNALS__ = undefined;
      }
    });

    it("stays hidden while the server is stopped", async () => {
      (window as any).__TAURI_INTERNALS__ = {};
      try {
        invoke.mockImplementation(async (cmd: string) => {
          if (cmd === "get_api_status")
            return { running: false, port: 17717, lan_access: false };
          return null;
        });
        renderPage("server");
        await screen.findByText("Local API server");
        expect(screen.queryByTestId("automation-open-demo")).toBeNull();
      } finally {
        (window as any).__TAURI_INTERNALS__ = undefined;
      }
    });
  });
});
