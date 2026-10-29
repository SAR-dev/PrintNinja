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
}));

import { SettingsPage } from "@/pages/Settings";

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
const renderPage = () =>
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
const open = (name: string) => {
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
};

describe("Settings page", () => {
  it("lists sections in a vertical navigation", () => {
    renderPage();
    const list = screen.getByRole("tablist", { name: "Settings sections" });
    expect(list).toHaveAttribute("aria-orientation", "vertical");
    for (const n of [
      "Profile",
      "General",
      "Background",
      "Share",
      "Data sources",
      "Retention",
      "Diagnostics",
    ]) {
      expect(within(list).getByRole("tab", { name: n })).toBeInTheDocument();
    }
  });

  it("has no theme control (single light theme)", () => {
    renderPage();
    expect(screen.queryByText(/^Theme$/)).toBeNull();
  });

  it("rejects an invalid retention value inline and does not save it", async () => {
    renderPage();
    open("Retention");
    const input = await screen.findByLabelText("Keep history for (days)");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "whole number of at least 1",
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(
      invoke.mock.calls.some(
        (c) => c[0] === "set_setting" && c[1]?.key === "retention_days",
      ),
    ).toBe(false);
  });

  it("saves a valid retention value", async () => {
    renderPage();
    open("Retention");
    const input = await screen.findByLabelText("Keep history for (days)");
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(localStorage.getItem("printninja-setting:retention_days")).toBe(
        "90",
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("prefills the service URL from the build-time default when nothing is saved", async () => {
    // The share client is mocked (no saved address); the env default is
    // real, so the field still fills — and stays empty without it.
    vi.stubEnv("VITE_DEFAULT_SHARE_URL", "https://share.example.com/");
    try {
      renderPage();
      open("Share");
      expect(await screen.findByLabelText("Service URL")).toHaveValue(
        "https://share.example.com",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a bad domain and confirms before allowing all", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_setting") return "api.example.com";
      return null;
    });
    renderPage();
    open("Data sources");
    const input = await screen.findByLabelText(/allowed domains/i);
    fireEvent.change(input, { target: { value: "https://evil.example/path" } });
    fireEvent.blur(input);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "is not a domain",
    );
    expect(
      invoke.mock.calls.some(
        (c) => c[0] === "set_setting" && c[1]?.key === "allowed_domains",
      ),
    ).toBe(false);

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Allow data from any domain?"),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow all" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_setting", {
        key: "allowed_domains",
        value: "",
      }),
    );
  });

  it("no longer carries the API: that lives on the Automation page", () => {
    renderPage();
    expect(
      screen.queryByRole("tab", { name: "API and automation" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Local REST API")).not.toBeInTheDocument();
    expect(screen.queryByText("Trusted Sources")).not.toBeInTheDocument();
  });

  it("offers diagnostics export in its own section", async () => {
    renderPage();
    open("Diagnostics");
    expect(
      await screen.findByRole("button", { name: /Export Diagnostics/ }),
    ).toBeInTheDocument();
  });

  it("downloads the backend app log from the diagnostics section", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_app_logs") return "line one\nline two\n";
      return null;
    });
    const urls: string[] = [];
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = (() => {
      urls.push("blob:app-log");
      return "blob:app-log";
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    try {
      renderPage();
      open("Diagnostics");
      fireEvent.click(
        await screen.findByRole("button", { name: /Download App Log/ }),
      );
      await waitFor(() =>
        expect(invoke.mock.calls.some((c) => c[0] === "read_app_logs")).toBe(
          true,
        ),
      );
      expect(urls).toEqual(["blob:app-log"]);
    } finally {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    }
  });

  it("views the backend app log in a dialog", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_app_logs") return "tail line one\ntail line two\n";
      return null;
    });
    renderPage();
    open("Diagnostics");
    fireEvent.click(
      await screen.findByRole("button", { name: /View App Log/ }),
    );
    expect(await screen.findByText(/tail line one/)).toBeInTheDocument();
  });

  it("does not open the viewer when the log is unreadable", async () => {
    invoke.mockImplementation(async () => {
      throw new Error("no backend");
    });
    renderPage();
    open("Diagnostics");
    fireEvent.click(
      await screen.findByRole("button", { name: /View App Log/ }),
    );
    // The click reached the backend (then failed into a toast, which
    // needs a live Toaster to assert on); no dialog may open.
    await waitFor(() =>
      expect(invoke.mock.calls.some((c) => c[0] === "read_app_logs")).toBe(
        true,
      ),
    );
    expect(screen.queryByText(/tail line one/)).toBeNull();
  });

  it("persists background toggles and asks the backend to re-apply them", async () => {
    renderPage();
    open("Background");
    const closeToTray = await screen.findByTestId("settings-close-to-tray");
    expect(closeToTray).toHaveAttribute("aria-checked", "true");
    fireEvent.click(closeToTray);
    await waitFor(() =>
      expect(localStorage.getItem("printninja-setting:close_to_tray")).toBe(
        "0",
      ),
    );
    expect(invoke.mock.calls.some((c) => c[0] === "refresh_background")).toBe(
      true,
    );

    const startMinimized = screen.getByTestId("settings-start-minimized");
    expect(startMinimized).toBeDisabled();
    const launch = screen.getByTestId("settings-launch-at-startup");
    fireEvent.click(launch);
    await waitFor(() => expect(startMinimized).not.toBeDisabled());
  });
});

describe("Settings database reset", () => {
  const stubReload = () => {
    const original = Object.getOwnPropertyDescriptor(window, "location");
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload },
    });
    return {
      reload,
      restore: () => {
        if (original) Object.defineProperty(window, "location", original);
      },
    };
  };

  it("asks for confirmation and wipes the database on confirm", async () => {
    const { reload, restore } = stubReload();
    try {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "reset_database") {
          return {
            templates: 2,
            template_versions: 3,
            print_jobs: 1,
            fonts: 0,
            datasets: 0,
            profiles: 0,
            printers: 1,
            batches: 0,
          };
        }
        return null;
      });
      renderPage();
      open("Retention");
      fireEvent.click(await screen.findByTestId("settings-reset-database"));
      expect(
        await screen.findByText("Erase everything on this PC?"),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Erase everything" }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("reset_database", {}),
      );
      await waitFor(() => expect(reload).toHaveBeenCalled());
    } finally {
      restore();
    }
  });

  it("does nothing when the confirmation is cancelled", async () => {
    renderPage();
    open("Retention");
    fireEvent.click(await screen.findByTestId("settings-reset-database"));
    expect(
      await screen.findByText("Erase everything on this PC?"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByText("Erase everything on this PC?")).toBeNull(),
    );
    expect(invoke.mock.calls.some((c) => c[0] === "reset_database")).toBe(
      false,
    );
  });

  it("flashes the control for a palette deep-link (?section=&field=)", async () => {
    render(
      <MemoryRouter
        initialEntries={["/settings?section=background&field=start-minimized"]}
      >
        <SettingsPage />
      </MemoryRouter>,
    );
    const target = await screen.findByTestId("settings-start-minimized");
    expect(document.getElementById("start-minimized")).not.toBeNull();
    await waitFor(() => expect(target).toHaveClass("ring-2"));
  });
});
