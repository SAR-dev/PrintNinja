import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@/lib/i18n";
import { RenderEngineNotice } from "@/components/RenderEngineNotice";
import type { RenderEngineStatus } from "@/lib/agent/types";
import { linuxInstall, needsBrowserHelp } from "@/lib/render/engineHelp";

const mockAgent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent/commands", () => ({
  agent: (...args: unknown[]) => mockAgent(...args),
}));
vi.mock("@/lib/appUpdate", () => ({ openExternalUrl: vi.fn() }));

const ok: RenderEngineStatus = {
  platform: "linux",
  available: true,
  path: "/usr/bin/chromium",
  searched: ["chromium"],
  distro: ["debian"],
  distro_name: "Debian GNU/Linux 12",
  appimage: false,
};
const linuxMissing: RenderEngineStatus = {
  ...ok,
  available: false,
  path: null,
  searched: ["chromium", "google-chrome"],
};
const windowsMissing: RenderEngineStatus = {
  platform: "windows",
  available: false,
  path: null,
  searched: [
    String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
    String.raw`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
  ],
  distro: [],
  distro_name: null,
  appimage: false,
};

let current: RenderEngineStatus | Error;
beforeEach(() => {
  mockAgent.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd !== "get_render_engine_status") throw new Error("no backend");
    if (current instanceof Error) throw current;
    return current;
  });
});
afterEach(() => vi.clearAllMocks());

describe("distro advice", () => {
  it("maps derivatives to their family, Ubuntu before Debian", () => {
    expect(linuxInstall(["linuxmint", "ubuntu", "debian"]).family).toBe(
      "ubuntu",
    );
    expect(linuxInstall(["debian"]).command).toContain("apt install chromium");
    expect(linuxInstall(["fedora"]).command).toBe("sudo dnf install chromium");
    expect(linuxInstall(["endeavouros", "arch"]).family).toBe("arch");
    expect(linuxInstall([]).family).toBe("generic");
  });

  it("does not send Ubuntu users to the Snap build", () => {
    const u = linuxInstall(["ubuntu", "debian"]);
    expect(u.avoidSnap).toBe(true);
    expect(u.command).not.toContain("snap");
  });

  it("only raises the alarm for a known-missing browser", () => {
    expect(needsBrowserHelp(null)).toBe(false);
    expect(needsBrowserHelp(ok)).toBe(false);
    expect(
      needsBrowserHelp({ ...ok, platform: "other", available: false }),
    ).toBe(false);
    expect(needsBrowserHelp(linuxMissing)).toBe(true);
  });
});

describe("<RenderEngineNotice />", () => {
  it("renders nothing while the browser is installed", async () => {
    current = ok;
    render(<RenderEngineNotice />);
    await waitFor(() => expect(mockAgent).toHaveBeenCalled());
    expect(screen.queryByTestId("render-engine-indicator")).toBeNull();
    expect(screen.queryByTestId("render-engine-dialog")).toBeNull();
  });

  it("stays silent when the status cannot be read", async () => {
    current = new Error("no backend");
    render(<RenderEngineNotice />);
    await waitFor(() => expect(mockAgent).toHaveBeenCalled());
    expect(screen.queryByTestId("render-engine-indicator")).toBeNull();
  });

  it("opens by itself on Linux with the distro's install command", async () => {
    current = linuxMissing;
    render(<RenderEngineNotice />);
    const dialog = await screen.findByTestId("render-engine-dialog");
    expect(dialog).toHaveTextContent(/No Chromium-based browser found/);
    expect(dialog).toHaveTextContent("Debian GNU/Linux 12");
    expect(dialog).toHaveTextContent("sudo apt install chromium");
    expect(dialog).toHaveTextContent("PRINTNINJA_CHROMIUM_BIN");
  });

  it("opens on Windows with the Edge steps and the paths it checks", async () => {
    current = windowsMissing;
    render(<RenderEngineNotice />);
    const dialog = await screen.findByTestId("render-engine-dialog");
    expect(dialog).toHaveTextContent(/Microsoft Edge is not installed/);
    expect(dialog).toHaveTextContent("winget install --id Microsoft.Edge -e");
    expect(dialog).toHaveTextContent(/Program Files\\Microsoft\\Edge/);
  });

  it("can be dismissed and reopened from the badge", async () => {
    current = linuxMissing;
    render(<RenderEngineNotice />);
    await screen.findByTestId("render-engine-dialog");
    fireEvent.click(screen.getByRole("button", { name: /remind me later/i }));
    await waitFor(() =>
      expect(screen.queryByTestId("render-engine-dialog")).toBeNull(),
    );
    fireEvent.click(screen.getByTestId("render-engine-indicator"));
    expect(await screen.findByTestId("render-engine-dialog")).toBeTruthy();
  });

  it("closes itself once a re-check finds the browser", async () => {
    current = linuxMissing;
    render(<RenderEngineNotice />);
    await screen.findByTestId("render-engine-dialog");
    current = ok;
    fireEvent.click(screen.getByTestId("render-engine-recheck"));
    await waitFor(() =>
      expect(screen.queryByTestId("render-engine-dialog")).toBeNull(),
    );
    expect(screen.queryByTestId("render-engine-indicator")).toBeNull();
  });
});
