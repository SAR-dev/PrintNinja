import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import "@/lib/i18n";
import {
  ErrorBoundary,
  RouteErrorFallback,
  AppErrorFallback,
} from "@/components/ErrorBoundary";

beforeEach(() => {
  // Crashes are expected here; keep the console quiet and give the
  // clipboard a body to hit (jsdom has none).
  vi.spyOn(console, "error").mockImplementation(() => {});
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => {}) },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function Boom({ fail }: { fail: boolean }) {
  if (fail) throw new Error("boom");
  return <div>recovered</div>;
}

describe("ErrorBoundary (page)", () => {
  it("shows the fallback, and Try again recovers the page", async () => {
    function Harness() {
      const [fail, setFail] = useState(true);
      return (
        <ErrorBoundary
          context="test page"
          fallback={(error, reset) => (
            <RouteErrorFallback
              error={error}
              onRetry={() => {
                setFail(false);
                reset();
              }}
            />
          )}
        >
          <Boom fail={fail} />
        </ErrorBoundary>
      );
    }
    render(
      <MemoryRouter>
        <Harness />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: "Something went wrong" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("recovered")).toBeInTheDocument();
  });

  it("lets the person leave a broken page; the next route is clean", async () => {
    // Mirrors the app: the boundary is keyed by pathname, so navigating
    // remounts it and the crash state does not carry over.
    function Harness() {
      const location = useLocation();
      return (
        <ErrorBoundary
          key={location.pathname}
          context="test page"
          fallback={(error, reset) => (
            <RouteErrorFallback error={error} onRetry={reset} />
          )}
        >
          <Routes>
            <Route path="/" element={<Boom fail />} />
            <Route path="/print" element={<div>print page</div>} />
          </Routes>
        </ErrorBoundary>
      );
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Harness />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: "Something went wrong" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to Print" }));
    expect(await screen.findByText("print page")).toBeInTheDocument();
  });

  it("offers a reload, not a retry, when a chunk fails to load", async () => {
    function ChunkPage(): ReactElement {
      throw new Error(
        "Failed to fetch dynamically imported module: /assets/print-abc.js",
      );
    }
    render(
      <MemoryRouter>
        <ErrorBoundary
          context="test page"
          fallback={(error, reset) => (
            <RouteErrorFallback error={error} onRetry={reset} />
          )}
        >
          <ChunkPage />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", {
        name: "This page could not be loaded",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
    // jsdom cannot stub location.reload, so this asserts the action
    // exists; the reload itself is the same call the app fallback uses.
    expect(
      screen.getByRole("button", { name: "Reload the app" }),
    ).toBeInTheDocument();
  });
});

describe("ErrorBoundary (app)", () => {
  it("offers a reload and a copy of the diagnostics", async () => {
    function Boom(): ReactElement {
      throw new Error("boom");
    }
    render(
      <ErrorBoundary
        context="test app"
        fallback={(error) => <AppErrorFallback error={error} />}
      >
        <Boom />
      </ErrorBoundary>,
    );
    expect(
      await screen.findByRole("heading", {
        name: "PrintNinja ran into a problem",
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    expect(
      await screen.findByRole("button", { name: "Copied" }),
    ).toBeInTheDocument();
  });
});
