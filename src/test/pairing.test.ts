import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import {
  filterPairingInput,
  formatPairingCode,
  hasPairedProvider,
  isCompletePairingCode,
  normalizePairingCode,
} from "@/lib/pairing";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

beforeEach(() => {
  localStorage.clear();
  invoke.mockReset().mockResolvedValue(null);
});

describe("hasPairedProvider", () => {
  it("is false with nothing stored", async () => {
    await expect(hasPairedProvider()).resolves.toBe(false);
  });

  it("is false with pairs but no auto policy", async () => {
    localStorage.setItem(
      "printninja-setting:render_pairs",
      JSON.stringify([{ id: "p1", name: "PC" }]),
    );
    localStorage.setItem("printninja-setting:render_policy", "local");
    await expect(hasPairedProvider()).resolves.toBe(false);
  });

  it("is false with auto policy but no pairs", async () => {
    localStorage.setItem("printninja-setting:render_policy", "auto");
    await expect(hasPairedProvider()).resolves.toBe(false);
  });

  it("is true with pairs and the auto policy", async () => {
    localStorage.setItem(
      "printninja-setting:render_pairs",
      JSON.stringify([
        { id: "p1", name: "PC", host: "192.168.1.9", port: 17717 },
      ]),
    );
    localStorage.setItem("printninja-setting:render_policy", "auto");
    await expect(hasPairedProvider()).resolves.toBe(true);
  });

  describe("on Android", () => {
    const realUa = navigator.userAgent;
    const setUa = (ua: string) =>
      Object.defineProperty(navigator, "userAgent", {
        value: ua,
        configurable: true,
      });
    beforeEach(() => setUa("Mozilla/5.0 (Linux; Android 14) AppleWebKit"));
    afterEach(() => setUa(realUa));

    it("needs only a pair: a phone always renders through its PC", async () => {
      localStorage.setItem(
        "printninja-setting:render_pairs",
        JSON.stringify([
          { id: "p1", name: "PC", host: "192.168.1.9", port: 17717 },
        ]),
      );
      localStorage.setItem("printninja-setting:render_policy", "local");
      await expect(hasPairedProvider()).resolves.toBe(true);
    });

    it("is still false with nothing paired", async () => {
      localStorage.setItem("printninja-setting:render_policy", "auto");
      await expect(hasPairedProvider()).resolves.toBe(false);
    });
  });

  it("survives broken JSON", async () => {
    localStorage.setItem("printninja-setting:render_pairs", "not json");
    localStorage.setItem("printninja-setting:render_policy", "auto");
    await expect(hasPairedProvider()).resolves.toBe(false);
  });

  it("prefers the backend over the local cache", async () => {
    invoke.mockImplementation(async (cmd: string, args: unknown) => {
      const key = (args as { key?: string })?.key;
      if (cmd === "get_setting" && key === "render_policy") return "auto";
      if (cmd === "get_setting" && key === "render_pairs")
        return JSON.stringify([{ id: "p1", name: "PC" }]);
      return null;
    });
    await expect(hasPairedProvider()).resolves.toBe(true);
  });
});

describe("pairing codes", () => {
  it("normalizes lowercase, dashes and spaces", () => {
    expect(normalizePairingCode("k7qm-4xpd")).toBe("K7QM4XPD");
    expect(normalizePairingCode("k7qm 4xpd")).toBe("K7QM4XPD");
    expect(normalizePairingCode("  K7QM-4XPD\n")).toBe("K7QM4XPD");
  });

  it("filters keystrokes to the alphabet", () => {
    // 0 O 1 I never reach the field; dashes and spaces are cosmetic.
    expect(filterPairingInput("k7qm-4xpd!!01oi")).toBe("K7QM4XPD");
    expect(filterPairingInput("01oi")).toBe("");
    expect(filterPairingInput("K7QM4XPDZZZZ")).toBe("K7QM4XPD");
  });

  it("is complete only at 8 alphabet characters", () => {
    expect(isCompletePairingCode("K7QM-4XPD")).toBe(true);
    expect(isCompletePairingCode("k7qm 4xpd")).toBe(true);
    expect(isCompletePairingCode("K7QM4XP")).toBe(false);
    expect(isCompletePairingCode("")).toBe(false);
  });

  it("formats the display form with a dash", () => {
    expect(formatPairingCode("K7QM4XPD")).toBe("K7QM-4XPD");
  });
});
