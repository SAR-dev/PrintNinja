import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import "@/lib/i18n";
import { login, endSession, onSessionStarted } from "@/lib/share/client";
import { useShareStatus } from "@/lib/shell/useShareStatus";

const SERVER = "http://server.test";
const OWNER_KEY = "printninja-setting:cache_owner_user_id";

const tauriInvoke = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => tauriInvoke.fn(...a),
}));

let me: { id: string; handle: string };
let cleared: number;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("printninja-setting:share_service_url", SERVER);
  cleared = 0;
  me = { id: "u1", handle: "SayedRafi" };
  tauriInvoke.fn.mockReset();
  tauriInvoke.fn.mockImplementation(
    async (cmd: string, args?: { key?: string; value?: string }) => {
      if (cmd === "cache_clear_account") {
        cleared += 1;
        return 0;
      }
      if (cmd === "get_setting")
        return localStorage.getItem(`printninja-setting:${args?.key}`);
      if (cmd === "set_setting" && args?.key) {
        if (args.value)
          localStorage.setItem(`printninja-setting:${args.key}`, args.value);
        else localStorage.removeItem(`printninja-setting:${args.key}`);
        return null;
      }
      return null;
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req =
        input instanceof Request ? input : new Request(input as string, init);
      if (req.url.endsWith("/v2/auth/login"))
        return json({ token: `tok-${me.id}`, user: me });
      if (req.url.endsWith("/v2/auth/me")) return json(me);
      return json({}, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("switching accounts on one device", () => {
  it("empties the local cache when a different account signs in", async () => {
    await login("SayedRafi", "pw-pw-pw-pw");
    expect(cleared).toBe(1); // unknown owner: cache cannot be trusted
    expect(localStorage.getItem(OWNER_KEY)).toBe("u1");

    await endSession("signed_out");
    me = { id: "u2", handle: "FariyaLaboni" };
    await login("FariyaLaboni", "pw-pw-pw-pw");

    expect(cleared).toBe(2);
    expect(localStorage.getItem(OWNER_KEY)).toBe("u2");
  });

  it("keeps the cache (and unsaved drafts) for the same account", async () => {
    await login("SayedRafi", "pw-pw-pw-pw");
    await endSession("expired");
    await login("SayedRafi", "pw-pw-pw-pw");
    expect(cleared).toBe(1);
  });

  it("clears before the new session is announced", async () => {
    await login("SayedRafi", "pw-pw-pw-pw");
    await endSession("signed_out");
    me = { id: "u2", handle: "FariyaLaboni" };
    let clearedAtStart = -1;
    const off = onSessionStarted(() => {
      clearedAtStart = cleared;
    });
    await login("FariyaLaboni", "pw-pw-pw-pw");
    off();
    expect(clearedAtStart).toBe(2);
  });
});

describe("top bar identity", () => {
  function Probe() {
    const s = useShareStatus();
    return <p data-testid="who">{s.state === "online" ? s.handle : s.state}</p>;
  }

  it("follows the account across sign-out and sign-in without remounting", async () => {
    await login("SayedRafi", "pw-pw-pw-pw");
    render(<Probe />);
    await waitFor(() =>
      expect(screen.getByTestId("who").textContent).toBe("SayedRafi"),
    );

    await act(async () => {
      await endSession("signed_out");
    });
    await waitFor(() =>
      expect(screen.getByTestId("who").textContent).toBe("signed_out"),
    );

    me = { id: "u2", handle: "FariyaLaboni" };
    await act(async () => {
      await login("FariyaLaboni", "pw-pw-pw-pw");
    });
    await waitFor(() =>
      expect(screen.getByTestId("who").textContent).toBe("FariyaLaboni"),
    );
  });
});
