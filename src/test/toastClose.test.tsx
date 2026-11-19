import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { Toaster } from "@/components/ui/sonner";
import { notifySuccess } from "@/lib/notify";

// The toaster's position (and close button) follow platform detection.
const platform = vi.hoisted(() => ({ isAndroid: vi.fn(() => true) }));
vi.mock("@/lib/platform", () => platform);

async function showAToast(): Promise<HTMLElement> {
  render(<Toaster />);
  notifySuccess("Saved");
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>("[data-sonner-toast]");
    expect(el, "toast never rendered").toBeTruthy();
    return el as HTMLElement;
  });
}

describe("toaster close button", () => {
  beforeEach(() => {
    platform.isAndroid.mockReset();
    platform.isAndroid.mockReturnValue(true);
  });

  it("gives every phone toast a close button that dismisses it", async () => {
    const el = await showAToast();
    const close = el.querySelector("[data-close-button]");
    expect(close, "no close button on the toast").toBeTruthy();

    fireEvent.click(close as Element);
    await waitFor(() => expect(el).toHaveAttribute("data-removed", "true"));
    // The Toaster unmounts the toast after its exit animation.
    await waitFor(
      () => expect(document.querySelector("[data-sonner-toast]")).toBeNull(),
      { timeout: 2000 },
    );
  });

  it("keeps desktop toasts as they are (no close button)", async () => {
    platform.isAndroid.mockReturnValue(false);
    const el = await showAToast();
    expect(el.querySelector("[data-close-button]")).toBeNull();
  });
});
