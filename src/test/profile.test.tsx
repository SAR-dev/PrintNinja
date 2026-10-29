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
    // The password form moved here from the Share section.
    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
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

  it("signs out in one click and says so", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(client.logout).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Signed out",
        expect.anything(),
      ),
    );
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

  it("points to Share settings when nobody is signed in", async () => {
    client.getSessionToken.mockResolvedValue(null);
    renderCard();
    const link = await screen.findByRole("link", {
      name: "Open Share settings",
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
