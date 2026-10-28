import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@/lib/i18n";
import { PairingGate } from "@/components/PairingGate";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

// DevicesCard talks to the backend on mount; answer like a fresh
// install with nothing paired and sharing off.
beforeEach(() => {
  localStorage.clear();
  invoke.mockReset().mockImplementation(async () => null);
});

describe("PairingGate", () => {
  it("explains the PC requirement and shows the pairing UI", async () => {
    const view = render(<PairingGate onPaired={() => {}} />);
    expect(
      await screen.findByText(/Pair your PC to start printing/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/always goes through a paired PC/),
    ).toBeInTheDocument();
    view.unmount();
  });

  it("lets the app through once a pair lands", async () => {
    const onPaired = vi.fn();
    const view = render(<PairingGate onPaired={onPaired} />);
    await screen.findByText(/Pair your PC to start printing/);
    expect(onPaired).not.toHaveBeenCalled();

    // Pairing happens in the embedded Devices UI (here simulated by
    // writing what it would save); the next poll notices it.
    localStorage.setItem(
      "printninja-setting:render_pairs",
      JSON.stringify([{ id: "p1", name: "PC" }]),
    );
    localStorage.setItem("printninja-setting:render_policy", "auto");
    await waitFor(() => expect(onPaired).toHaveBeenCalled(), {
      timeout: 8000,
    });
    view.unmount();
  });

  it("stays put while unpaired", async () => {
    const onPaired = vi.fn();
    const view = render(<PairingGate onPaired={onPaired} />);
    await screen.findByText(/Pair your PC to start printing/);
    // Longer than one poll: still no pair, still no pass.
    await new Promise((r) => setTimeout(r, 2500));
    expect(onPaired).not.toHaveBeenCalled();
    view.unmount();
  });

  // Regression: pairing used to be noticed only by the gate's 2s poll, so
  // after a successful pair the freshly-paired device sat on the welcome
  // screen for up to two seconds before /print replaced it. Pairing now
  // signals onPaired directly, so it must fire well before any poll tick.
  it("leaves immediately when a pair is made, not on the next poll", async () => {
    const ua = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile");
    (window as any).__TAURI_INTERNALS__ = {}; // leave web mode: real pairing form
    const settings: Record<string, string> = {};
    invoke.mockImplementation(async (cmd: string, args?: any) => {
      switch (cmd) {
        case "get_setting":
          return settings[String(args?.key)] ?? null;
        case "set_setting":
          settings[String(args?.key)] = String(args?.value);
          return null;
        case "pair_with_code":
          return {
            id: "provider-1",
            name: "Shop PC",
            host: "192.168.1.9",
            port: 17717,
            secret: "tokentokentokentokentokentoken01",
            fingerprint: "f".repeat(64),
            provider_id: "provider-1",
          };
        case "peer_capabilities":
          return { protocol: 1, can_render: true, score: 800, cores: 8 };
        default:
          return null;
      }
    });

    try {
      const onPaired = vi.fn();
      const view = render(<PairingGate onPaired={onPaired} />);
      const input = await screen.findByTestId("devices-code-input");
      expect(onPaired).not.toHaveBeenCalled();

      const t0 = Date.now();
      fireEvent.change(input, { target: { value: "k7qm-4xpd" } });
      fireEvent.click(screen.getByTestId("devices-code-submit"));

      // Direct signal, not the 2000ms poll: well inside one tick.
      await waitFor(() => expect(onPaired).toHaveBeenCalled(), {
        timeout: 1500,
      });
      expect(Date.now() - t0).toBeLessThan(2000);
      view.unmount();
    } finally {
      (window as any).__TAURI_INTERNALS__ = undefined;
      ua.mockRestore();
    }
  });
});
