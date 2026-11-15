import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@/lib/i18n";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const listSessions = vi.fn();
const revokeSession = vi.fn();
vi.mock("@/lib/share/client", () => ({
  listSessions: (...a: unknown[]) => listSessions(...a),
  revokeSession: (...a: unknown[]) => revokeSession(...a),
}));

import { SignedInSessions } from "@/components/SignedInSessions";

const sessions = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    device_label: "Windows",
    current: true,
    created_at: "2026-03-01T10:00:00.000Z",
    last_used_at: "2026-03-02T09:30:00.000Z",
    expires_at: "2026-04-01T10:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    device_label: "Android",
    current: false,
    created_at: "2026-02-01T10:00:00.000Z",
    last_used_at: "2026-02-28T18:05:00.000Z",
    expires_at: "2026-03-30T10:00:00.000Z",
  },
];

describe("SignedInSessions", () => {
  beforeEach(() => {
    listSessions.mockReset();
    revokeSession.mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it("lists sessions, marks the current one and revokes another", async () => {
    listSessions.mockResolvedValue({ items: sessions });
    revokeSession.mockResolvedValue({ revoked: 1 });

    render(<SignedInSessions busy={false} setBusy={() => {}} />);
    expect(await screen.findByText("Windows")).toBeInTheDocument();

    const rows = screen.getAllByTestId("settings-session-row");
    expect(rows).toHaveLength(2);
    // Exactly one row carries the "This device" badge: the caller.
    expect(screen.getByTestId("settings-session-current")).toHaveTextContent(
      "This device",
    );
    expect(rows[0]).toHaveTextContent("This device");
    expect(rows[1]).not.toHaveTextContent("This device");
    // Last use is shown as a local date-time, not a raw ISO string.
    expect(rows[0].textContent).not.toContain("2026-03-02T09:30:00.000Z");

    // Revoking the other device calls the API with its id and reloads.
    fireEvent.click(screen.getAllByTestId("settings-session-revoke")[1]);
    await waitFor(() =>
      expect(revokeSession).toHaveBeenCalledWith(sessions[1]?.id),
    );
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
    expect(toast.success).toHaveBeenCalled();
  });

  it("shows a retryable error when the list fails", async () => {
    listSessions.mockRejectedValue(new Error("network down"));

    render(<SignedInSessions busy={false} setBusy={() => {}} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    listSessions.mockResolvedValue({ items: sessions });
    fireEvent.click(screen.getByTestId("settings-sessions-retry"));
    expect(await screen.findByText("Windows")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports an empty list without revoke buttons", async () => {
    listSessions.mockResolvedValue({ items: [] });

    render(<SignedInSessions busy={false} setBusy={() => {}} />);
    expect(await screen.findByText("No sessions found")).toBeInTheDocument();
    expect(
      screen.queryByTestId("settings-session-revoke"),
    ).not.toBeInTheDocument();
  });
});
