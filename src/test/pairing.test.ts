import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import {
  duplicatePairGroups,
  filterPairingInput,
  hasPairedProvider,
  isCompletePairingCode,
  mergePhonePair,
  normalizePairHost,
  normalizePairingCode,
  pairAddressKey,
} from "@/lib/pairing";
import type { RenderPair } from "@/lib/agent/types";

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

  it("shows the plain code, with no display dash", () => {
    // The dash is gone from every display; input tolerance for old
    // habits stays in normalize/filter above.
    expect(normalizePairingCode("K7QM4XPD")).toBe("K7QM4XPD");
  });
});

describe("pair address identity", () => {
  const P = (over: Partial<RenderPair>): RenderPair => ({
    id: "x",
    name: "PC",
    host: "192.168.1.9",
    port: 17717,
    secret: "s",
    fingerprint: "",
    provider_id: "pc-1",
    platform: "linux",
    paired_at: "2026-01-01T00:00:00Z",
    device_id: "phone-1",
    ...over,
  });

  it("normalizes cosmetic host differences", async () => {
    expect(normalizePairHost("  PC.local. ")).toBe("pc.local");
    expect(normalizePairHost("[::1]")).toBe("::1");
    expect(pairAddressKey("PC.LOCAL.", 17717)).toBe(
      pairAddressKey("pc.local", 17717),
    );
    expect(pairAddressKey("pc.local", 17717)).not.toBe(
      pairAddressKey("pc.local", 17718),
    );
  });

  it("replaces the same provider silently on a moved address", async () => {
    const { pairs, replacedStale } = mergePhonePair(
      [P({ provider_id: "a", host: "192.168.1.9" })],
      P({ provider_id: "a", host: "192.168.1.20" }),
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].host).toBe("192.168.1.20");
    expect(replacedStale).toBe(false);
  });

  it("replaces a reset PC at the same address and says so", async () => {
    const { pairs, replacedStale } = mergePhonePair(
      [P({ provider_id: "old" })],
      P({ provider_id: "new" }),
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].provider_id).toBe("new");
    expect(replacedStale).toBe(true);
  });

  it("keeps distinct PCs and spots duplicate groups", async () => {
    const { pairs } = mergePhonePair(
      [P({ provider_id: "a", host: "192.168.1.9" })],
      P({ provider_id: "b", host: "192.168.1.10" }),
    );
    expect(pairs).toHaveLength(2);
    expect(
      duplicatePairGroups([
        P({ provider_id: "a", host: "PC.local" }),
        P({ provider_id: "b", host: "pc.local." }),
        P({ provider_id: "c", host: "192.168.1.10" }),
      ]),
    ).toHaveLength(1);
  });
});
