import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
});
