import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@/lib/i18n";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const changePassword = vi.fn();
vi.mock("@/lib/share/client", () => ({
  changePassword: (...a: unknown[]) => changePassword(...a),
}));

import { ChangePasswordForm } from "@/components/ChangePasswordForm";

const fill = (current: string, next: string, confirm: string) => {
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: current },
  });
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: next },
  });
  fireEvent.change(screen.getByLabelText("Confirm new"), {
    target: { value: confirm },
  });
};

describe("ChangePasswordForm", () => {
  beforeEach(() => {
    changePassword.mockReset();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
  });

  it("validates locally before touching the network", async () => {
    render(<ChangePasswordForm busy={false} setBusy={() => {}} />);
    const submit = screen.getByRole("button", { name: "Change password" });

    fill("", "new-password-1", "new-password-1");
    fireEvent.click(submit);
    // Field-level, not a toast: the fix sits next to the field.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter the current password",
    );

    fill("old", "short", "short");
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The new password needs at least 8 characters",
    );

    fill("old", "new-password-1", "different");
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The new passwords do not match",
    );

    expect(changePassword).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("calls changePassword and reports revoked sessions", async () => {
    changePassword.mockResolvedValue({ revoked: 2 });
    render(<ChangePasswordForm busy={false} setBusy={() => {}} />);
    fill("old-password", "new-password-1", "new-password-1");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith(
        "old-password",
        "new-password-1",
      ),
    );
    expect(vi.mocked(toast.success).mock.calls[0][0]).toBe(
      "Password changed — 2 other session(s) signed out",
    );
    // Cleared after success.
    expect(screen.getByLabelText("Current password")).toHaveValue("");
  });

  it("surfaces server failures", async () => {
    changePassword.mockRejectedValue(new Error("401 Unauthorized"));
    render(<ChangePasswordForm busy={false} setBusy={() => {}} />);
    fill("wrong", "new-password-1", "new-password-1");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() =>
      expect(vi.mocked(toast.error).mock.calls[0][0]).toBe("401 Unauthorized"),
    );
  });
});
