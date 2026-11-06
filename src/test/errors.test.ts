import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeError, isAlreadyExists } from "@/lib/errors";
import i18n, { setLanguage } from "@/lib/i18n";

describe("describeError", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("en");
  });
  afterEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("en");
  });

  it("keeps English output identical to the Rust wording", () => {
    expect(describeError({ NotFound: "Template 3 not found" })).toBe(
      "Template 3 not found",
    );
    expect(describeError("Select a printer first")).toBe(
      "Select a printer first",
    );
    expect(describeError({ DuplicateJob: 7 })).toBe(
      "Idempotency key already used by job 7",
    );
  });

  it("translates serialized AppError variants into Japanese", async () => {
    await setLanguage("ja");
    expect(describeError({ NotFound: "Template 3 not found" })).toBe(
      "テンプレート 3 が見つかりません",
    );
    expect(describeError({ Validation: "Printer name required" })).toBe(
      "プリンター名を入力してください",
    );
    expect(describeError({ DuplicateJob: 7 })).toContain("ジョブ 7");
  });

  it("translates plain-string errors and captures parameters", async () => {
    await setLanguage("ja");
    expect(describeError("A printer named 'Front' already exists")).toBe(
      "「Front」という名前のプリンターが既にあります",
    );
    expect(describeError("Unknown deep link action: foo")).toBe(
      "不明なディープリンク操作です: foo",
    );
    expect(describeError("Could not reach 10.0.0.5: timed out")).toBe(
      "10.0.0.5 に接続できませんでした: timed out",
    );
  });

  it("translates the render-timeout wording to the same message", async () => {
    await setLanguage("ja");
    // The render deadline reports the same failure in the same words;
    // it must translate, not leak English.
    expect(describeError("PDF render timed out after 75s")).toBe(
      "PDFのレンダリングが 75 秒でタイムアウトしました",
    );
  });

  it("explains the server's generic 403 instead of leaking 'Not allowed'", async () => {
    // A save that PUTs to a template id owned by a different account.
    expect(describeError(new Error("Not allowed"))).toContain(
      "different account",
    );
    await setLanguage("ja");
    expect(describeError(new Error("Not allowed"))).toContain("別のアカウント");
  });
  it("names the Edge handoff failure and an unkillable Edge", async () => {
    expect(
      describeError(
        "Edge handed the print job to a running Edge session (exit 0, no PDF) — close all Edge windows, or run Fix PC printing (Settings > Diagnostics)",
      ),
    ).toContain("running Edge session");
    expect(
      describeError(
        "Edge could not be stopped after 15 rounds of taskkill — msedge.exe is still running. Close every Edge window, then run the repair again.",
      ),
    ).toContain("15 rounds of taskkill");
    await setLanguage("ja");
    expect(
      describeError(
        "Edge handed the print job to a running Edge session (exit 0, no PDF)",
      ),
    ).toContain("Edge セッション");
    expect(
      describeError(
        "Edge could not be stopped after 15 rounds of taskkill — msedge.exe is still running.",
      ),
    ).toContain("15 回");
  });

  it("names the elevated-parent failure and how to fix it", async () => {
    expect(
      describeError(
        "PrintNinja is running as administrator — Edge will not print from an elevated process. Restart PrintNinja normally (without 'Run as administrator'), then try again.",
      ),
    ).toBe(
      "PrintNinja is running as administrator. Edge cannot print from an elevated process. Restart PrintNinja without 'Run as administrator' and try again.",
    );
    // The repair appends its own suffix; the pattern matches the opening.
    expect(
      describeError(
        "PrintNinja is running as administrator — Edge will not print from an elevated process. Restart PrintNinja normally (without 'Run as administrator'), then try again. The repair cannot succeed while PrintNinja is elevated — restart it normally, then run the repair again.",
      ),
    ).toBe(
      "PrintNinja is running as administrator. Edge cannot print from an elevated process. Restart PrintNinja without 'Run as administrator' and try again.",
    );
    await setLanguage("ja");
    expect(
      describeError(
        "PrintNinja is running as administrator — Edge will not print from an elevated process.",
      ),
    ).toContain("管理者");
  });

  it("labels an unmapped variant and keeps the raw detail", async () => {
    await setLanguage("ja");
    expect(describeError({ Internal: "disk exploded" })).toBe(
      "内部エラー: disk exploded",
    );
    expect(describeError({ Database: "no such table: x" })).toBe(
      "データベースエラー: no such table: x",
    );
  });

  it("passes unknown strings and Error messages through untouched", async () => {
    await setLanguage("ja");
    expect(describeError("something new")).toBe("something new");
    expect(describeError(new Error("HTTP 502"))).toBe("HTTP 502");
    expect(describeError({ message: "boom" })).toBe("boom");
  });

  it("never prints [object Object]", () => {
    expect(describeError({ weird: 1, shape: 2 })).not.toContain(
      "[object Object]",
    );
  });

  it("detects the already-exists conflict in any shape", () => {
    expect(isAlreadyExists("A template named 'x' already exists")).toBe(true);
    expect(
      isAlreadyExists({ Validation: "A printer named 'x' already exists" }),
    ).toBe(true);
    expect(isAlreadyExists("nope")).toBe(false);
  });
});
