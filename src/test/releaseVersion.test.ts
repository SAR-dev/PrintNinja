import { describe, it, expect } from "vitest";
import packageRaw from "../../package.json?raw";
import tauriConfRaw from "../../src-tauri/tauri.conf.json?raw";
// biome-ignore format: single line keeps the ts-expect-error on the error line
// @ts-expect-error plain .mjs script without types
import { androidVersionCode, assertBuildable, checkLabel, cmpVersions, dateVersionPrefix, isDateVersion, listTakenVersions, msiVersion, nextDateVersion, parseDateVersion, platformVersionProblems, withVersion } from "../../scripts/lib/version.mjs";

const FIXTURE = `${JSON.stringify(
  {
    productName: "PrintNinja",
    version: "5.1.2",
    bundle: {
      active: true,
      icon: ["icons/32x32.png"],
      linux: { deb: { depends: ["cups"] } },
    },
  },
  null,
  2,
)}\n`;

describe("dateVersionPrefix", () => {
  it("uses MMDD without a leading zero", () => {
    expect(dateVersionPrefix(new Date(2026, 11, 25))).toBe("2026.1225");
    expect(dateVersionPrefix(new Date(2026, 10, 9))).toBe("2026.1109");
    expect(dateVersionPrefix(new Date(2027, 0, 5))).toBe("2027.105");
    expect(dateVersionPrefix(new Date(2027, 8, 5))).toBe("2027.905");
  });
});

describe("nextDateVersion", () => {
  const date = new Date(2026, 11, 25);

  it("starts the day at 0", () => {
    expect(nextDateVersion({ date, taken: [], current: "5.1.2" })).toBe(
      "2026.1225.0",
    );
  });

  it("counts up from the highest release of the same day", () => {
    expect(
      nextDateVersion({ date, taken: ["2026.1225.0", "2026.1225.1"] }),
    ).toBe("2026.1225.2");
    expect(
      nextDateVersion({ date, taken: ["2026.1225.0", "2026.1225.4"] }),
    ).toBe("2026.1225.5");
  });

  it("ignores other days and non-version strings", () => {
    expect(
      nextDateVersion({
        date,
        taken: ["2026.1224.7", "2025.1225.3", "junk", "2026.1225.x"],
      }),
    ).toBe("2026.1225.0");
  });

  it("also respects the version already in the manifests", () => {
    expect(nextDateVersion({ date, taken: [], current: "2026.1225.2" })).toBe(
      "2026.1225.3",
    );
  });

  it("refuses a 101st release in one day", () => {
    expect(() => nextDateVersion({ date, taken: ["2026.1225.99"] })).toThrow(
      /100 releases/,
    );
  });
});

describe("parseDateVersion", () => {
  it("accepts real dates", () => {
    expect(parseDateVersion("2026.1225.0")).toEqual({
      year: 2026,
      month: 12,
      day: 25,
      n: 0,
    });
    expect(parseDateVersion("2027.105.3")).toEqual({
      year: 2027,
      month: 1,
      day: 5,
      n: 3,
    });
  });

  it("rejects everything else", () => {
    for (const v of [
      "5.1.2",
      "2026.1332.0",
      "2026.1301.0",
      "2026.1200.0",
      "2026.1225.100",
      "1999.1225.0",
      "2026.1225",
      "x",
    ]) {
      expect(parseDateVersion(v)).toBeNull();
    }
    expect(isDateVersion("5.1.2")).toBe(false);
  });
});

describe("platform versions", () => {
  it("maps the MSI version into its limits", () => {
    expect(msiVersion("2026.1225.3")).toBe("26.12.2503");
    expect(msiVersion("2027.105.0")).toBe("27.1.500");
  });

  it("builds an Android versionCode", () => {
    expect(androidVersionCode("2026.1225.3")).toBe(26122503);
    expect(androidVersionCode("2027.105.0")).toBe(27010500);
  });

  it("stays valid and strictly increasing for every day and release, across New Year", () => {
    let prevMsi: number[] = [];
    let prevCode = 0;
    for (let year = 2026; year <= 2030; year++) {
      for (let month = 0; month < 12; month++) {
        const days = new Date(year, month + 1, 0).getDate();
        for (let day = 1; day <= days; day++) {
          for (const n of [0, 1, 99]) {
            const v = `${dateVersionPrefix(new Date(year, month, day))}.${n}`;
            const msi = msiVersion(v).split(".").map(Number);
            expect(msi[0]).toBeLessThanOrEqual(255);
            expect(msi[1]).toBeLessThanOrEqual(255);
            expect(msi[2]).toBeLessThanOrEqual(65535);
            const code = androidVersionCode(v);
            expect(code).toBeLessThanOrEqual(2_100_000_000);
            if (prevMsi.length)
              expect(
                cmpVersions(msi.join("."), prevMsi.join(".")),
              ).toBeGreaterThan(0);
            expect(code).toBeGreaterThan(prevCode);
            prevMsi = msi;
            prevCode = code;
          }
        }
      }
    }
  });

  it("is higher than the last non-date release on both platforms", () => {
    expect(androidVersionCode("2026.1109.0")).toBeGreaterThan(
      5 * 1_000_000 + 1 * 1_000 + 2,
    );
    expect(cmpVersions(msiVersion("2026.1109.0"), "5.1.2")).toBeGreaterThan(0);
  });

  it("explains why Tauri's default Android math is not used", () => {
    const derived = (v: string) => {
      const [a, b, c] = v.split(".").map(Number);
      return a * 1_000_000 + b * 1_000 + c;
    };
    // 31 Dec -> 1 Jan would go DOWN with the derived code; Android rejects that.
    expect(derived("2027.101.0")).toBeLessThan(derived("2026.1231.0"));
  });
});

describe("assertBuildable", () => {
  it("allows ordinary versions and date versions", () => {
    expect(() => assertBuildable("5.1.3")).not.toThrow();
    expect(() => assertBuildable("2026.1225.0")).not.toThrow();
  });

  it("refuses versions the MSI cannot hold", () => {
    expect(() => assertBuildable("2026.5.0")).toThrow(/MSI/);
    expect(() => assertBuildable("300.0.0")).toThrow(/MSI/);
    expect(() => assertBuildable("nope")).toThrow(/not a version/);
  });
});

describe("withVersion (tauri.conf.json)", () => {
  it("adds the overrides for a date version and keeps the rest", () => {
    const out = JSON.parse(withVersion(FIXTURE, "2026.1225.3"));
    expect(out.version).toBe("2026.1225.3");
    expect(out.bundle.windows.wix.version).toBe("26.12.2503");
    expect(out.bundle.android.versionCode).toBe(26122503);
    expect(out.bundle.linux.deb.depends).toEqual(["cups"]);
    expect(out.productName).toBe("PrintNinja");
  });

  it("removes the overrides again for a normal version, back to the original bytes", () => {
    const dated = withVersion(FIXTURE, "2026.1225.3");
    expect(withVersion(dated, "5.1.2")).toBe(FIXTURE);
  });

  it("is idempotent and keeps CRLF files CRLF", () => {
    const once = withVersion(FIXTURE, "2026.1225.0");
    expect(withVersion(once, "2026.1225.0")).toBe(once);
    const crlf = withVersion(FIXTURE.replace(/\n/g, "\r\n"), "2026.1225.0");
    expect(crlf).toContain("\r\n");
    expect(crlf.replace(/\r\n/g, "\n")).toBe(once);
  });

  it("leaves other android/windows settings alone when removing", () => {
    const text = `${JSON.stringify({ version: "2026.1225.0", bundle: { android: { minSdkVersion: 26, versionCode: 1 }, windows: { wix: { version: "1.2.3", language: "en-US" } } } }, null, 2)}\n`;
    const out = JSON.parse(withVersion(text, "5.1.3"));
    expect(out.bundle.android).toEqual({ minSdkVersion: 26 });
    expect(out.bundle.windows.wix).toEqual({ language: "en-US" });
  });
});

describe("platformVersionProblems", () => {
  it("is empty when overrides match", () => {
    expect(
      platformVersionProblems(
        withVersion(FIXTURE, "2026.1225.3"),
        "2026.1225.3",
      ),
    ).toEqual([]);
    expect(platformVersionProblems(FIXTURE, "5.1.2")).toEqual([]);
  });

  it("reports missing or stale overrides", () => {
    expect(platformVersionProblems(FIXTURE, "2026.1225.3")).toHaveLength(2);
    expect(
      platformVersionProblems(
        withVersion(FIXTURE, "2026.1225.3"),
        "2026.1225.4",
      ),
    ).toHaveLength(2);
    expect(
      platformVersionProblems(withVersion(FIXTURE, "2026.1225.3"), "5.1.2"),
    ).toHaveLength(2);
  });

  it("the repo's own tauri.conf.json matches package.json", () => {
    const version = JSON.parse(packageRaw).version as string;
    expect(JSON.parse(tauriConfRaw).version).toBe(version);
    expect(platformVersionProblems(tauriConfRaw, version)).toEqual([]);
  });
});

describe("listTakenVersions", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  it("merges local and remote tags, including peeled annotated tags", () => {
    const git = (...args: string[]) => {
      if (args[0] === "tag") return "v2026.1225.0\nv2026.1225.1";
      return `${sha}\trefs/tags/v2026.1225.1\n${sha}\trefs/tags/v2026.1225.1^{}\n${sha}\trefs/tags/v2026.1225.2`;
    };
    const { versions, remoteOk } = listTakenVersions(git, "2026.1225");
    expect(remoteOk).toBe(true);
    expect([...versions].sort()).toEqual([
      "2026.1225.0",
      "2026.1225.1",
      "2026.1225.2",
    ]);
  });

  it("falls back to local tags when origin is unreachable", () => {
    const git = (...args: string[]) => {
      if (args[0] === "tag") return "v2026.1225.0";
      throw new Error("offline");
    };
    expect(listTakenVersions(git, "2026.1225")).toEqual({
      versions: ["2026.1225.0"],
      remoteOk: false,
    });
  });

  it("copes with no tags at all", () => {
    expect(listTakenVersions(() => "", "2026.1225")).toEqual({
      versions: [],
      remoteOk: true,
    });
  });
});

describe("checkLabel", () => {
  it("accepts short plain text", () => {
    expect(checkLabel("major")).toBe("");
    expect(checkLabel("hotfix: printer crash")).toBe("");
  });

  it("rejects empty, multi-line and very long labels", () => {
    expect(checkLabel("")).not.toBe("");
    expect(checkLabel("  ")).not.toBe("");
    expect(checkLabel("a\nb")).not.toBe("");
    expect(checkLabel("x".repeat(61))).not.toBe("");
  });
});
