import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";
import { AutomationPage } from "@/pages/Automation";
import { useFlashField } from "@/lib/hooks/useFlashField";

vi.mock("@/lib/agent/commands", () => ({
  agent: () => Promise.reject(new Error("no backend")),
}));

beforeEach(() => {
  localStorage.clear();
});

function LateTarget() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setShown(true), 400);
    return () => window.clearTimeout(id);
  }, []);
  useFlashField("late", true);
  return shown ? <input id="late" aria-label="late" /> : null;
}

describe("useFlashField", () => {
  it("retries until a control that loads late appears", async () => {
    render(<LateTarget />);
    const el = await screen.findByLabelText("late");
    await waitFor(() => expect(el).toHaveClass("ring-2"), { timeout: 2000 });
  });

  it("does nothing without a field", () => {
    function None() {
      useFlashField(null, true);
      return <input id="x" aria-label="x" />;
    }
    render(<None />);
    expect(screen.getByLabelText("x")).not.toHaveClass("ring-2");
  });

  it("removes the ring after the flash", async () => {
    vi.useFakeTimers();
    try {
      function Now() {
        useFlashField("now", true);
        return <input id="now" aria-label="now" />;
      }
      render(<Now />);
      const el = screen.getByLabelText("now");
      expect(el).toHaveClass("ring-2");
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      expect(el).not.toHaveClass("ring-2");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Automation deep link", () => {
  it("flashes the LAN switch from a palette link", async () => {
    render(
      <MemoryRouter
        initialEntries={["/automation?tab=server&field=lan-access"]}
      >
        <AutomationPage />
      </MemoryRouter>,
    );
    const lan = await screen.findByRole("switch", {
      name: "Allow LAN access",
    });
    await waitFor(() => expect(lan).toHaveClass("ring-2"));
  });

  it("opens the tab named in the link", async () => {
    render(
      <MemoryRouter
        initialEntries={["/automation?tab=links&field=trusted-source-input"]}
      >
        <AutomationPage />
      </MemoryRouter>,
    );
    const input = await screen.findByLabelText(/trusted/i, {
      selector: "#trusted-source-input",
    });
    await waitFor(() => expect(input).toHaveClass("ring-2"));
  });
});
