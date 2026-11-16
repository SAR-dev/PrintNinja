import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@/lib/i18n";

import { NotifyOnSettings } from "@/components/NotifyOnSettings";

beforeEach(() => {
  localStorage.clear();
});

describe("NotifyOnSettings", () => {
  it("defaults to notifying on failures only", () => {
    render(<NotifyOnSettings />);
    expect(screen.getByTestId("settings-notify-on")).toBeInTheDocument();
    expect(screen.getByTestId("settings-notify-on-failures")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("settings-notify-on-all")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByTestId("settings-notify-on-never")).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("persists the choice when an option is selected", async () => {
    render(<NotifyOnSettings />);
    fireEvent.click(screen.getByTestId("settings-notify-on-all"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-notify-on-all")).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    expect(localStorage.getItem("printninja-setting:notify_on")).toBe("all");
  });

  it("restores the stored choice on start", async () => {
    localStorage.setItem("printninja-setting:notify_on", "never");
    render(<NotifyOnSettings />);
    await waitFor(() =>
      expect(screen.getByTestId("settings-notify-on-never")).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
  });
});
