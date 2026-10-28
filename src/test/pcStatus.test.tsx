import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";
import { PcStatusBanner } from "@/components/PcStatusBanner";
import { describeError } from "@/lib/errors";
import {
  checkPairedPcs,
  episodeKeyFor,
  summarizePcChecks,
} from "@/lib/shell/usePcStatus";

const agentMock = vi.fn();
vi.mock("@/lib/agent/commands", () => ({
  agent: (...a: unknown[]) => agentMock(...a),
}));

let android = true;
vi.mock("@/lib/platform", () => ({ isAndroid: () => android }));

let storedPairs: unknown = [];
vi.mock("@/lib/settings", () => ({
  readSetting: async (key: string) =>
    key === "render_pairs" ? JSON.stringify(storedPairs) : null,
}));

const pair = (name: string, port = 17717) => ({
  id: name,
  name,
  host: "192.168.1.9",
  port,
  secret: "s3cret",
  fingerprint: "",
});

const BLOCKED =
  "Studio PC is blocked or unreachable (no answer on port 17717). Check that the PC is on and awake, on the same Wi-Fi, and that its firewall allows PrintNinja.";

beforeEach(() => {
  agentMock.mockReset();
  android = true;
  storedPairs = [pair("Studio PC")];
});

describe("summarizePcChecks", () => {
  it("says nothing when there is nothing paired", () => {
    expect(summarizePcChecks([])).toEqual({ state: "none" });
  });

  it("is up as soon as one PC answers", () => {
    expect(
      summarizePcChecks([
        { name: "Old PC", error: "Old PC is blocked or unreachable" },
        { name: "Studio PC", error: null },
      ]),
    ).toEqual({ state: "up", name: "Studio PC" });
  });

  it("is down only when every PC failed, and names the first", () => {
    expect(
      summarizePcChecks([
        { name: "Studio PC", error: "first reason" },
        { name: "Old PC", error: "second reason" },
      ]),
    ).toEqual({
      state: "down",
      name: "Studio PC",
      reason: "first reason",
      total: 2,
    });
  });

  it("counts a lone failure as one", () => {
    expect(summarizePcChecks([{ name: "A", error: "x" }])).toEqual({
      state: "down",
      name: "A",
      reason: "x",
      total: 1,
    });
  });
});

describe("episodeKeyFor", () => {
  it("is null unless every paired PC failed", () => {
    expect(episodeKeyFor([])).toBeNull();
    expect(
      episodeKeyFor([
        { name: "A", error: "x" },
        { name: "B", error: null },
      ]),
    ).toBeNull();
  });

  it("names the failing set, sorted so probe order cannot flip it", () => {
    const key = episodeKeyFor([
      { name: "Studio PC", error: "x" },
      { name: "Old PC", error: "y" },
    ]);
    expect(key).toBe("down:Old PC,Studio PC");
    expect(
      episodeKeyFor([
        { name: "Old PC", error: "other reason" },
        { name: "Studio PC", error: "x" },
      ]),
    ).toBe(key);
  });

  it("changes when the failing set changes", () => {
    const one = episodeKeyFor([{ name: "A", error: "x" }]);
    const two = episodeKeyFor([
      { name: "A", error: "x" },
      { name: "B", error: "y" },
    ]);
    expect(one).not.toBe(two);
  });
});

describe("checkPairedPcs", () => {
  it("probes each stored pair with its name, address and secret", async () => {
    storedPairs = [pair("Studio PC"), pair("Old PC", 9000)];
    agentMock.mockResolvedValue({ can_render: true });
    const { status, key } = await checkPairedPcs();
    expect(status).toEqual({ state: "up", name: "Studio PC" });
    expect(key).toBeNull();
    expect(agentMock).toHaveBeenCalledWith("peer_capabilities", {
      host: "192.168.1.9",
      port: 17717,
      secret: "s3cret",
      name: "Studio PC",
    });
    expect(agentMock).toHaveBeenCalledWith("peer_capabilities", {
      host: "192.168.1.9",
      port: 9000,
      secret: "s3cret",
      name: "Old PC",
    });
  });

  it("reports the PC's own reason when nothing answers", async () => {
    agentMock.mockRejectedValue({ Validation: BLOCKED });
    const { status, key } = await checkPairedPcs();
    expect(status.state).toBe("down");
    expect(key).toBe("down:Studio PC");
    if (status.state === "down") {
      expect(status.name).toBe("Studio PC");
      expect(status.reason).toContain("blocked or unreachable");
      expect(status.total).toBe(1);
    }
  });
});

describe("describeError for an unreachable PC", () => {
  it("passes the firewall wording through in the current language", () => {
    expect(describeError(BLOCKED)).toContain("firewall allows PrintNinja");
    expect(describeError(BLOCKED)).toContain("17717");
  });

  it("tells a refused connection apart from a silent one", () => {
    const refused =
      "Studio PC refused the connection on port 17717: the PC is reachable but PrintNinja is not sharing there. Open PrintNinja on it and turn on Wi-Fi access.";
    const text = describeError(refused);
    expect(text).toContain("not sharing");
    expect(text).not.toContain("firewall");
  });
});

describe("PcStatusBanner", () => {
  const view = () =>
    render(
      <MemoryRouter>
        <PcStatusBanner />
      </MemoryRouter>,
    );

  it("warns before printing when no paired PC answers", async () => {
    agentMock.mockRejectedValue({ Validation: BLOCKED });
    view();
    const banner = await screen.findByTestId("pc-down-banner");
    expect(banner).toHaveTextContent("Can’t reach Studio PC");
    expect(banner).toHaveTextContent("Prints from this phone will fail");
    // Single line by default: the detail hides behind the toggle.
    expect(banner).not.toHaveTextContent("blocked or unreachable");
  });

  it("reveals the reason behind the details toggle", async () => {
    agentMock.mockRejectedValue({ Validation: BLOCKED });
    view();
    await screen.findByTestId("pc-down-banner");
    const toggle = screen.getByTestId("pc-down-details");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("pc-down-banner")).toHaveTextContent(
      "blocked or unreachable",
    );
    fireEvent.click(toggle);
    expect(screen.getByTestId("pc-down-banner")).not.toHaveTextContent(
      "blocked or unreachable",
    );
  });

  it("names the outage honestly when several PCs are down", async () => {
    storedPairs = [pair("Studio PC"), pair("Old PC")];
    agentMock.mockRejectedValue({ Validation: BLOCKED });
    view();
    const banner = await screen.findByTestId("pc-down-banner");
    expect(banner).toHaveTextContent("Can’t reach any of your 2 PCs");
  });

  it("dismiss hides this outage, and a remount warns again", async () => {
    // Mute is in-memory by design: an app restart restores the warning
    // rather than muting it forever. Same-episode rechecks stay muted
    // structurally (mutedKey only ever equals its own episode key —
    // covered at the episodeKeyFor level); the resurface rule itself is
    // that any new key differs from the muted one.
    agentMock.mockRejectedValue({ Validation: BLOCKED });
    const first = view();
    await screen.findByTestId("pc-down-banner");
    fireEvent.click(screen.getByTestId("pc-down-dismiss"));
    expect(screen.queryByTestId("pc-down-banner")).not.toBeInTheDocument();
    first.unmount();
    view();
    await screen.findByTestId("pc-down-banner");
  });

  it("clears once the PC answers, from the Check again button", async () => {
    agentMock.mockRejectedValue({ Validation: BLOCKED });
    view();
    await screen.findByTestId("pc-down-banner");

    agentMock.mockResolvedValue({ can_render: true });
    fireEvent.click(screen.getByTestId("pc-down-retry"));
    await waitFor(() =>
      expect(screen.queryByTestId("pc-down-banner")).not.toBeInTheDocument(),
    );
  });

  it("stays out of the way while the PC answers", async () => {
    agentMock.mockResolvedValue({ can_render: true });
    view();
    await waitFor(() => expect(agentMock).toHaveBeenCalled());
    expect(screen.queryByTestId("pc-down-banner")).not.toBeInTheDocument();
  });

  it("never probes on a desktop", async () => {
    android = false;
    view();
    await new Promise((r) => setTimeout(r, 50));
    expect(agentMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("pc-down-banner")).not.toBeInTheDocument();
  });

  it("says nothing when nothing is paired", async () => {
    storedPairs = [];
    view();
    await new Promise((r) => setTimeout(r, 50));
    expect(agentMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("pc-down-banner")).not.toBeInTheDocument();
  });
});
