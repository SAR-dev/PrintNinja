import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@/lib/i18n";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const issueRecoveryCode = vi.fn();
vi.mock("@/lib/share/client", () => ({
  issueRecoveryCode: (...a: unknown[]) => issueRecoveryCode(...a),
}));

import { RecoveryCodeForm } from "@/components/RecoveryCodeForm";

describe("RecoveryCodeForm", () => {
  beforeEach(() => {
    issueRecoveryCode.mockReset();
    vi.mocked(toast.error).mockClear();
  });

  it("asks for the password first, without calling the server", async () => {
    render(<RecoveryCodeForm busy={false} setBusy={() => {}} />);
    fireEvent.click(screen.getByTestId("settings-recovery-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter the current password",
    );
    expect(issueRecoveryCode).not.toHaveBeenCalled();
  });

  it("shows the new code once, and hides it again when dismissed", async () => {
    issueRecoveryCode.mockResolvedValue({
      recovery_code: "ABCDE-FGHJK-LMNPQ-RSTUV",
    });
    render(<RecoveryCodeForm busy={false} setBusy={() => {}} />);
    fireEvent.change(screen.getByLabelText("Confirm with your password"), {
      target: { value: "my password" },
    });
    fireEvent.click(screen.getByTestId("settings-recovery-submit"));

    expect(await screen.findByTestId("recovery-code")).toHaveTextContent(
      "ABCDE-FGHJK-LMNPQ-RSTUV",
    );
    expect(issueRecoveryCode).toHaveBeenCalledWith("my password");

    fireEvent.click(screen.getByTestId("settings-recovery-done"));
    await waitFor(() =>
      expect(screen.queryByTestId("recovery-code")).not.toBeInTheDocument(),
    );
    // Back to the empty form, with the password cleared.
    expect(screen.getByLabelText("Confirm with your password")).toHaveValue("");
  });

  it("reports a wrong password and shows no code", async () => {
    issueRecoveryCode.mockRejectedValue(
      new Error("Current password is incorrect"),
    );
    render(<RecoveryCodeForm busy={false} setBusy={() => {}} />);
    fireEvent.change(screen.getByLabelText("Confirm with your password"), {
      target: { value: "nope" },
    });
    fireEvent.click(screen.getByTestId("settings-recovery-submit"));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByTestId("recovery-code")).not.toBeInTheDocument();
  });
});
