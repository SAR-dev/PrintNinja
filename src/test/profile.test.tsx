import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";
import { toast } from "sonner";
import { SessionExpiredError } from "@/lib/api/errors";
import { ProfileCard } from "@/components/ProfileCard";
import { parseSection } from "@/lib/setup/checklist";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const client = vi.hoisted(() => ({
  getServiceUrl: vi.fn(),
  getSessionToken: vi.fn(),
  fetchMe: vi.fn(),
  logout: vi.fn(),
  changePassword: vi.fn(),
  changeHandle: vi.fn(),
  setSessionHandle: vi.fn(),
  getSessionHandle: vi.fn(),
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  onSessionStarted: vi.fn((cb: () => void) => {
    window.addEventListener("printninja:session-started", cb);
    return () => window.removeEventListener("printninja:session-started", cb);
  }),
}));
vi.mock("@/lib/share/client", () => client);

const renderCard = () =>
  render(
    <MemoryRouter>
      <ProfileCard />
    </MemoryRouter>,
  );

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.getServiceUrl.mockResolvedValue("https://share.example");
  client.getSessionToken.mockResolvedValue("tok");
  client.fetchMe.mockResolvedValue({
    id: "u1",
    handle: "rafi",
    created_at: "2026-03-01T10:00:00.000Z",
  });
  client.logout.mockResolvedValue(undefined);
  client.getSessionHandle.mockReturnValue(null);
  client.listSessions.mockResolvedValue({ items: [] });
  client.revokeSession.mockResolvedValue({ revoked: 1 });
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("Profile section", () => {
  it("is a known Settings section", () => {
    expect(parseSection("profile")).toBe("profile");
  });

  it("names the signed-in account and offers sign out", async () => {
    renderCard();
    expect(await screen.findByTestId("profile-handle")).toHaveTextContent(
      "rafi",
    );
    expect(screen.getByText(/Member since/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
    // The password form moved here from the Account & sync section.
    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
  });

  it("shows the local session handle on first paint, before fetchMe", async () => {
    // A stored handle means a live session, so the identity must not wait
    // on the network: no "not signed in" / "checking" flash on landing.
    client.getSessionHandle.mockReturnValue("rafi");
    client.fetchMe.mockReturnValue(new Promise(() => {})); // never settles
    renderCard();
    expect(screen.getByTestId("profile-handle")).toHaveTextContent("rafi");
  });

  it("reloads when a new session starts without remounting", async () => {
    // The shell hides rather than unmounts across logout→login, so a
    // mount-time read would show the old session forever. Regression:
    // logging in again must refresh the already-mounted card.
    client.getSessionToken.mockResolvedValue(null);
    renderCard();
    expect(await screen.findByText(/not signed in/i)).toBeInTheDocument();

    client.getSessionToken.mockResolvedValue("fresh-tok");
    client.fetchMe.mockResolvedValue({
      id: "u9",
      handle: "sam",
      created_at: "2026-03-01T10:00:00.000Z",
    });
    window.dispatchEvent(new CustomEvent("printninja:session-started"));
    expect(await screen.findByTestId("profile-handle")).toHaveTextContent(
      "sam",
    );
  });

  it("changes the handle and refreshes the display", async () => {
    client.changeHandle.mockResolvedValue({
      id: "u1",
      handle: "SayedRafi",
      created_at: "2026-03-01T10:00:00.000Z",
    });
    // First read is the mount-time profile; the reload after the change
    // returns the renamed account.
    client.fetchMe
      .mockResolvedValueOnce({
        id: "u1",
        handle: "rafi",
        created_at: "2026-03-01T10:00:00.000Z",
      })
      .mockResolvedValue({
        id: "u1",
        handle: "SayedRafi",
        created_at: "2026-03-01T10:00:00.000Z",
      });
    renderCard();
    await screen.findByTestId("profile-handle");

    fireEvent.change(screen.getByTestId("settings-change-handle-new"), {
      target: { value: "SayedRafi" },
    });
    fireEvent.click(screen.getByTestId("settings-change-handle-submit"));

    await waitFor(() =>
      expect(client.changeHandle).toHaveBeenCalledWith("SayedRafi"),
    );
    expect(client.setSessionHandle).toHaveBeenCalledWith("SayedRafi");
    expect(await screen.findByTestId("profile-handle")).toHaveTextContent(
      "SayedRafi",
    );
  });

  it("signs out in one click", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(client.logout).toHaveBeenCalledOnce());
    // The card switches to its signed-out face — no toast for a result
    // the screen already shows.
    expect(
      await screen.findByText(/You are not signed in/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("profile-handle")).toBeNull();
  });

  it("still lets you sign out when the service cannot be reached", async () => {
    client.fetchMe.mockRejectedValue(new Error("network down"));
    renderCard();
    expect(
      await screen.findByText(/Cannot reach the share service/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(client.logout).toHaveBeenCalledOnce());
  });

  it("points to the Account & sync section when nobody is signed in", async () => {
    client.getSessionToken.mockResolvedValue(null);
    renderCard();
    const link = await screen.findByRole("link", {
      name: "Open Account & sync",
    });
    expect(link).toHaveAttribute("href", "/settings?section=share");
    expect(client.fetchMe).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("treats an expired session as signed out", async () => {
    client.fetchMe.mockRejectedValue(new SessionExpiredError());
    renderCard();
    expect(
      await screen.findByText(/You are not signed in/),
    ).toBeInTheDocument();
  });
});
