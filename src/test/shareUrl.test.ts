import { beforeEach, describe, expect, it } from "vitest";
import * as share from "@/lib/share/client";

// The service URL setting is canonical: stored trimmed and without any
// trailing slash, so the `${base}${path}` request URLs can never double
// up. The Tauri agent is unreachable in Vitest, so the setting round
// trips through the localStorage fallback (same as shareLibrary.test).
describe("service url normalization", () => {
  const KEY = "printninja-setting:share_service_url";

  beforeEach(() => {
    localStorage.clear();
  });

  it("reads a legacy value with multiple trailing slashes back clean", async () => {
    localStorage.setItem(KEY, "https://x.com//");
    await expect(share.getServiceUrl()).resolves.toBe("https://x.com");
  });

  it("stores a typed address without a trailing slash", async () => {
    await share.setServiceUrl("https://x.com/");
    expect(localStorage.getItem(KEY)).toBe("https://x.com");
  });

  it("stores a typed address without several trailing slashes", async () => {
    await share.setServiceUrl("https://x.com//");
    expect(localStorage.getItem(KEY)).toBe("https://x.com");
  });

  it("clears the stored address when given null or blanks", async () => {
    await share.setServiceUrl("https://x.com/");
    await share.setServiceUrl(null);
    expect(localStorage.getItem(KEY)).toBeNull();
    await share.setServiceUrl("https://y.com/");
    await share.setServiceUrl("   ");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("round-trips a slashed address to a clean one", async () => {
    await share.setServiceUrl(" https://x.com/ ");
    await expect(share.getServiceUrl()).resolves.toBe("https://x.com");
  });
});
