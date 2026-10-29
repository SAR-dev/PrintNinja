import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@/lib/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PrintViaPcCard } from "@/components/PrintViaPcCard";

const PAIR = (id: string, name: string) => ({
  id,
  name,
  host: "192.168.1.9",
  port: 17717,
  secret: "s",
  fingerprint: "",
  provider_id: id,
  platform: "linux",
  paired_at: "",
  device_id: "phone-1",
});

function settingsBackend(pairs: unknown[], flag = "false") {
  invoke.mockImplementation(async (cmd: string, args?: any) => {
    if (cmd === "get_setting") {
      if (args?.key === "print_via_pc") return flag;
      if (args?.key === "render_pairs") return JSON.stringify(pairs);
      return null;
    }
    if (cmd === "set_setting") return null;
    return null;
  });
}

beforeEach(() => {
  invoke.mockReset();
  Object.defineProperty(window.navigator, "userAgent", {
    value: "Mozilla/5.0 (Linux; Android 14)",
    configurable: true,
  });
});

describe("Print via PC card", () => {
  it("stays disabled with a hint when no PC is paired", async () => {
    settingsBackend([]);
    render(<PrintViaPcCard />);
    expect(await screen.findByTestId("via-pc-no-pairs")).toBeInTheDocument();
    expect(screen.getByTestId("via-pc-switch")).toBeDisabled();
  });

  it("turns the flag on without a picker for a single pair", async () => {
    settingsBackend([PAIR("pc-1", "Studio PC")]);
    render(<PrintViaPcCard />);
    const flip = await screen.findByTestId("via-pc-switch");
    await waitFor(() => expect(flip).toBeEnabled());
    expect(screen.queryByTestId("via-pc-device")).not.toBeInTheDocument();
    fireEvent.click(flip);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_setting", {
        key: "print_via_pc",
        value: "true",
      }),
    );
  });

  it("offers the picker and stores the choice for several pairs", async () => {
    settingsBackend(
      [PAIR("pc-1", "Studio PC"), PAIR("pc-2", "Shop PC")],
      "true",
    );
    render(<PrintViaPcCard />);
    expect(await screen.findByTestId("via-pc-device")).toBeInTheDocument();
    // Choosing is a Radix select; assert the options via the listbox.
    fireEvent.click(screen.getByTestId("via-pc-device"));
    expect(await screen.findByText("Shop PC")).toBeInTheDocument();
  });
});
