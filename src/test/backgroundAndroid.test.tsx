import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@/lib/i18n";

import {
  AndroidBackgroundControls,
  isAndroidBackground,
} from "@/components/BackgroundAndroid";

const realUA = window.navigator.userAgent;

function stubAndroidUA(): void {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    get: () =>
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36",
  });
}

const noop = () => {};

function renderControls(
  overrides: Partial<Parameters<typeof AndroidBackgroundControls>[0]> = {},
) {
  return render(
    <AndroidBackgroundControls
      running={true}
      exempt={false}
      notif={{ granted: false, canAskAgain: true }}
      busy={false}
      onRefresh={noop}
      onRequestExemption={noop}
      onRequestNotifications={noop}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  stubAndroidUA();
});

afterEach(() => {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    get: () => realUA,
  });
});

describe("AndroidBackgroundControls notifications row", () => {
  it("shows the allowed state without an ask button", () => {
    renderControls({ notif: { granted: true, canAskAgain: false } });
    expect(screen.getByText("Notifications")).toBeInTheDocument();
    expect(screen.getByText("allowed")).toBeInTheDocument();
    expect(
      screen.queryByTestId("settings-notification-permission"),
    ).not.toBeInTheDocument();
  });

  it("offers the prompt again while Android still prompts", () => {
    const onRequestNotifications = vi.fn();
    renderControls({
      notif: { granted: false, canAskAgain: true },
      onRequestNotifications,
    });
    // Scoped to the row: the battery badge says "not allowed" too.
    const row = within(screen.getByTestId("settings-notifications-row"));
    expect(row.getByText("not allowed")).toBeInTheDocument();
    const button = screen.getByTestId("settings-notification-permission");
    expect(button).toHaveTextContent("Allow notifications");
    fireEvent.click(button);
    expect(onRequestNotifications).toHaveBeenCalledTimes(1);
  });

  it("routes to the notification settings when Android will not prompt", () => {
    const onRequestNotifications = vi.fn();
    renderControls({
      notif: { granted: false, canAskAgain: false },
      onRequestNotifications,
    });
    const button = screen.getByTestId("settings-notification-permission");
    expect(button).toHaveTextContent("Open notification settings");
    fireEvent.click(button);
    expect(onRequestNotifications).toHaveBeenCalledTimes(1);
  });

  it("holds the badge and button back until the first state read lands", () => {
    renderControls({ notif: null });
    // "…" while unknown — never a claim the permission is denied.
    expect(screen.getByText("…")).toBeInTheDocument();
    expect(
      screen.queryByTestId("settings-notification-permission"),
    ).not.toBeInTheDocument();
  });

  it("renders nothing off Android (desktop uses tray settings)", () => {
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      get: () => "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131",
    });
    expect(isAndroidBackground()).toBe(false);
    const { container } = renderControls();
    expect(container).toBeEmptyDOMElement();
  });
});
