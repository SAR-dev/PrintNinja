import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import "@/lib/i18n";
import { Layout } from "@/components/Layout";
import { notifyApiStatusChanged } from "@/lib/apiServer";

const mockAgent = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agent/commands", () => ({
  agent: (...args: unknown[]) => mockAgent(...args),
}));

vi.mock("@/lib/shell/useShareStatus", () => ({
  useShareStatus: () => ({ state: "unconfigured" }),
}));

vi.mock("@/lib/sync/useSyncStatus", () => ({
  useSyncStatus: () => ({
    state: "synced",
    drafts: 0,
    lastPulledAt: null,
    lastError: null,
  }),
  cacheNow: vi.fn(async () => {}),
}));

vi.mock("@/lib/prefs/PrefsProvider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/prefs/PrefsProvider")>();
  return {
    ...actual,
    usePrefs: () => ({ appName: "PrintNinja", logo: undefined }),
  };
});

function Where() {
  return (
    <p data-testid="where">{useLocation().pathname + useLocation().search}</p>
  );
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/history"]}>
      <Layout>
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </Layout>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockAgent.mockReset();
  mockAgent.mockRejectedValue(new Error("no backend"));
});

describe("API indicator", () => {
  it("stays hidden when the API server is stopped", async () => {
    mockAgent.mockResolvedValue({
      running: false,
      address: "127.0.0.1",
      port: 17717,
      lan_access: false,
    });
    renderShell();
    await waitFor(() =>
      expect(mockAgent).toHaveBeenCalledWith("get_api_status", {}),
    );
    expect(screen.queryByTestId("lan-indicator")).not.toBeInTheDocument();
    expect(screen.queryByTestId("api-indicator")).not.toBeInTheDocument();
  });

  it("shows a green badge linking to Settings API when loopback-only", async () => {
    mockAgent.mockResolvedValue({
      running: true,
      address: "127.0.0.1",
      port: 17717,
      lan_access: false,
    });
    renderShell();
    const link = await screen.findByTestId("api-indicator");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/automation");
    expect(link).toHaveTextContent("API");
    expect(screen.queryByTestId("lan-indicator")).not.toBeInTheDocument();
    fireEvent.click(link);
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent("/automation"),
    );
  });

  it("stays hidden when the status cannot be read", async () => {
    renderShell();
    await waitFor(() => expect(mockAgent).toHaveBeenCalled());
    expect(screen.queryByTestId("lan-indicator")).not.toBeInTheDocument();
  });

  it("updates at once when another screen starts or stops the server", async () => {
    const stopped = {
      running: false,
      address: "127.0.0.1",
      port: 17717,
      lan_access: false,
    };
    const lan = {
      running: true,
      address: "0.0.0.0",
      port: 17717,
      lan_access: true,
    };
    mockAgent.mockResolvedValue(stopped);
    renderShell();
    await waitFor(() => expect(mockAgent).toHaveBeenCalled());
    expect(screen.queryByTestId("lan-indicator")).not.toBeInTheDocument();

    mockAgent.mockResolvedValue(lan);
    act(() => notifyApiStatusChanged());
    expect(await screen.findByTestId("lan-indicator")).toBeInTheDocument();

    mockAgent.mockResolvedValue(stopped);
    act(() => notifyApiStatusChanged());
    await waitFor(() =>
      expect(screen.queryByTestId("lan-indicator")).not.toBeInTheDocument(),
    );
  });

  it("shows a red alert linking to Settings API when LAN is on", async () => {
    mockAgent.mockResolvedValue({
      running: true,
      address: "0.0.0.0",
      port: 17717,
      lan_access: true,
    });
    renderShell();
    const link = await screen.findByTestId("lan-indicator");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/automation");
    expect(link).toHaveTextContent("LAN");
    fireEvent.click(link);
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent("/automation"),
    );
  });
});
