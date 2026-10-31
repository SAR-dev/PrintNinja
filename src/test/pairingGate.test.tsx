import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@/lib/i18n";
import { PairingGate } from "@/components/PairingGate";
import { toast } from "sonner";

function phoneMode() {
  const ua = vi
    .spyOn(window.navigator, "userAgent", "get")
    .mockReturnValue("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile");
  (window as any).__TAURI_INTERNALS__ = {}; // leave web mode: real pairing form
  return () => {
    (window as any).__TAURI_INTERNALS__ = undefined;
    ua.mockRestore();
  };
}

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

  it("shows who this phone pairs as, or that sign-in comes first", async () => {
    const ua = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile");
    (window as any).__TAURI_INTERNALS__ = {}; // leave web mode: real pairing form
    try {
      const view = render(<PairingGate onPaired={() => {}} />);
      await screen.findByTestId("devices-code-input");
      // Nothing configured: no session, so the sign-in hint shows.
      expect(
        await screen.findByTestId("devices-account-line"),
      ).toHaveTextContent(/Not signed in/);
      view.unmount();
    } finally {
      (window as any).__TAURI_INTERNALS__ = undefined;
      ua.mockRestore();
    }
  });

  it("names the signed-in account on the pair form", async () => {
    const ua = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile");
    (window as any).__TAURI_INTERNALS__ = {}; // leave web mode: real pairing form
    localStorage.setItem(
      "printninja-setting:share_service_url",
      "https://share.test",
    );
    localStorage.setItem("printninja-setting:share_session_token", "tok");
    invoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "get_setting")
        return localStorage.getItem(`printninja-setting:${args?.key}`);
      return null;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = input instanceof Request ? input.url : String(input);
        return url.endsWith("/v2/auth/me")
          ? new Response(JSON.stringify({ id: "u1", handle: "sam" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          : new Response("{}", { status: 404 });
      }),
    );
    try {
      render(<PairingGate onPaired={() => {}} />);
      await screen.findByTestId("devices-code-input");
      expect(
        await screen.findByTestId("devices-account-line"),
      ).toHaveTextContent("Signed in as sam");
    } finally {
      vi.unstubAllGlobals();
      (window as any).__TAURI_INTERNALS__ = undefined;
      ua.mockRestore();
    }
  });

  it("sends the picked handle as the PC's device name", async () => {
    const ua = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile");
    (window as any).__TAURI_INTERNALS__ = {};
    localStorage.setItem("printninja-session-handle", "sam");
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
      const view = render(<PairingGate onPaired={() => {}} />);
      const input = await screen.findByTestId("devices-code-input");
      fireEvent.change(input, { target: { value: "k7qm-4xpd" } });
      fireEvent.click(screen.getByTestId("devices-code-submit"));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(
          "pair_with_code",
          expect.objectContaining({ device_name: "sam" }),
        ),
      );
      view.unmount();
    } finally {
      (window as any).__TAURI_INTERNALS__ = undefined;
      ua.mockRestore();
    }
  });

  // Regression: pairing used to be noticed only by the gate's 2s poll, so  // after a successful pair the freshly-paired device sat on the welcome
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
      // Example code in XYZ letters, dimmed so it reads as a hint.
      expect(input).toHaveAttribute("placeholder", "XXXXXXXX");
      expect(input).toHaveClass("placeholder:opacity-50");

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

describe("PairingGate welcome", () => {
  it("greets the signed-in handle", async () => {
    localStorage.setItem("printninja-session-handle", "sam");
    const view = render(<PairingGate onPaired={() => {}} />);
    expect(await screen.findByText(/Welcome sam/)).toBeInTheDocument();
    view.unmount();
  });

  it("greets the guest handle in guest mode", async () => {
    localStorage.setItem("printninja-guest-mode", "true");
    localStorage.setItem("printninja-guest-handle", "guest-ana");
    const view = render(<PairingGate onPaired={() => {}} />);
    expect(await screen.findByText(/Welcome guest-ana/)).toBeInTheDocument();
    view.unmount();
  });

  it("prefers the session handle over a stale guest one", async () => {
    localStorage.setItem("printninja-guest-mode", "true");
    localStorage.setItem("printninja-guest-handle", "guest-ana");
    localStorage.setItem("printninja-session-handle", "sam");
    const view = render(<PairingGate onPaired={() => {}} />);
    expect(await screen.findByText(/Welcome sam/)).toBeInTheDocument();
    view.unmount();
  });

  it("stays nameless with no identity", async () => {
    const view = render(<PairingGate onPaired={() => {}} />);
    expect(
      await screen.findByText(/Pair your PC to start printing/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Welcome /)).not.toBeInTheDocument();
    view.unmount();
  });
});

describe("pair Test button", () => {
  const PAIR = {
    id: "pc-1",
    name: "Shop PC",
    host: "192.168.1.9",
    port: 17717,
    secret: "s",
    fingerprint: "",
    provider_id: "pc-1",
    platform: "linux",
    paired_at: "",
    device_id: "phone-1",
  };

  function pairedBackend(caps: unknown) {
    invoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "get_setting") {
        if (args?.key === "render_pairs") return JSON.stringify([PAIR]);
        return null;
      }
      if (cmd === "peer_capabilities") {
        if (caps instanceof Error) throw caps;
        return caps;
      }
      return null;
    });
  }

  it("announces a reachable PC out loud", async () => {
    const done = phoneMode();
    try {
      pairedBackend({ protocol: 1, can_render: true, score: 800, cores: 8 });
      render(<PairingGate onPaired={() => {}} />);
      fireEvent.click(await screen.findByTestId("devices-pair-test-pc-1"));
      await waitFor(() =>
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
          expect.stringContaining("Shop PC"),
          expect.anything(),
        ),
      );
    } finally {
      done();
    }
  });

  it("announces an unreachable PC out loud", async () => {
    const done = phoneMode();
    try {
      pairedBackend(new Error("Shop PC is blocked or unreachable"));
      render(<PairingGate onPaired={() => {}} />);
      fireEvent.click(await screen.findByTestId("devices-pair-test-pc-1"));
      await waitFor(() =>
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
          expect.stringContaining("unreachable"),
          expect.anything(),
        ),
      );
    } finally {
      done();
    }
  });
});
