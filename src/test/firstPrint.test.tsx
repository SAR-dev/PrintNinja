import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/lib/i18n";
import { FirstPrintMoment } from "@/components/FirstPrintMoment";
import { hasSeenFirstPrint, markFirstPrintSeen } from "@/lib/firstPrint";

beforeEach(() => {
  localStorage.clear();
});

describe("first print flag", () => {
  it("starts unseen and sticks once marked", () => {
    expect(hasSeenFirstPrint()).toBe(false);
    markFirstPrintSeen();
    expect(hasSeenFirstPrint()).toBe(true);
  });

  it("treats blocked storage as already seen", () => {
    const getItem = vi
      .spyOn(window.localStorage, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    try {
      expect(hasSeenFirstPrint()).toBe(true);
      expect(() => markFirstPrintSeen()).not.toThrow();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

describe("FirstPrintMoment", () => {
  it("shows once, then never again", () => {
    const { unmount } = render(<FirstPrintMoment />);
    expect(screen.getByTestId("first-print-moment")).toBeInTheDocument();
    expect(screen.getByTestId("first-print-moment")).toHaveTextContent(
      /first print/i,
    );
    unmount();
    // A fresh success banner (the second print) shows nothing.
    render(<FirstPrintMoment />);
    expect(screen.queryByTestId("first-print-moment")).toBeNull();
  });
});
