import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { ApiExplorerPanel } from "@/pages/ApiExplorer";

const running = {
  running: true,
  address: "127.0.0.1",
  port: 17717,
  lan_access: false,
};
const stopped = { ...running, running: false };

const openServer = vi.fn();

function renderPage() {
  return render(
    <MemoryRouter>
      <ApiExplorerPanel onOpenServer={openServer} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  invoke.mockReset();
  openServer.mockReset();
  localStorage.clear();
  (window as any).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  (window as any).__TAURI_INTERNALS__ = undefined;
});

describe("API Explorer and the server", () => {
  it("has no start or stop controls while the server runs", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_api_status") return running;
      return null;
    });
    renderPage();
    expect(await screen.findByText("127.0.0.1:17717")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /start server|stop server/i }),
    ).not.toBeInTheDocument();
    // Read-only: showing the page never changes the server.
    expect(invoke).not.toHaveBeenCalledWith(
      "stop_api_server",
      expect.anything(),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "start_api_server",
      expect.anything(),
    );
  });

  it("points to the server tab, instead of starting it, when it is stopped", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_api_status") return stopped;
      return null;
    });
    renderPage();
    const go = await screen.findByTestId("explorer-open-server");
    expect(
      screen.queryByRole("button", { name: /start server/i }),
    ).not.toBeInTheDocument();
    fireEvent.click(go);
    expect(openServer).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith(
      "start_api_server",
      expect.anything(),
    );
  });

  // The request must go through the Rust `api_request` command: a WebView
  // fetch to 127.0.0.1 is cross-origin (no ACAO on a loopback bind) and
  // mixed content, so it fails with "Failed to fetch" on Android.
  it("sends endpoint calls through the api_request command", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_api_status") return running;
      if (cmd === "api_request")
        return { status: 200, text: '{"status":"ok"}' };
      return null;
    });
    renderPage();

    fireEvent.click(await screen.findByTestId("api-explorer-send"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "api_request",
        expect.objectContaining({
          method: "GET",
          url: "http://127.0.0.1:17717/v1/health",
        }),
      );
    });
    expect(
      await screen.findByTestId("api-explorer-response"),
    ).toHaveTextContent('"status": "ok"');
  });

  it("lists the fully public pairing endpoints with their own guidance", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_api_status") return running;
      if (cmd === "api_request")
        return { status: 200, text: '{"token":"abc"}' };
      return null;
    });
    renderPage();
    await screen.findByText("127.0.0.1:17717");

    // The introduction needs no token and no body.
    fireEvent.click(screen.getByText("/v1/pair/hello"));
    expect(screen.queryByTestId("api-explorer-body")).toBeNull();
    fireEvent.click(await screen.findByTestId("api-explorer-send"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "api_request",
        expect.objectContaining({
          method: "GET",
          url: "http://127.0.0.1:17717/v1/pair/hello",
        }),
      );
    });

    // Claiming warns about the side effect and offers a claim example —
    // never the print body or an idempotency key.
    fireEvent.click(screen.getByText("/v1/pair/claim"));
    expect(
      await screen.findByText(/pairs a device with this PC/),
    ).toBeInTheDocument();
    expect(
      (screen.getByTestId("api-explorer-body") as HTMLTextAreaElement).value,
    ).toContain('"code": "K7QM4XPD"');
    expect(screen.queryByTestId("api-explorer-idempotency")).toBeNull();
    fireEvent.click(screen.getByTestId("api-explorer-send"));
    await waitFor(() => {
      const call = invoke.mock.calls.find(
        (c) =>
          c[0] === "api_request" &&
          (c[1] as any)?.url?.endsWith("/v1/pair/claim"),
      );
      expect(call).toBeDefined();
      expect((call?.[1] as any)?.headers?.["Idempotency-Key"]).toBeUndefined();
    });
  });
});
