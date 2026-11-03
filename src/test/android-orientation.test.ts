import { describe, it, expect } from "vitest";
// biome-ignore format: single line keeps the ts-expect-error on the error line
// @ts-expect-error plain .mjs script without types
import { patchOrientation, patchMainActivity } from "../../scripts/patch-android-orientation.mjs";

const MANIFEST = `<manifest>
  <application>
    <activity android:name=".MainActivity" android:launchMode="singleTask"/>
  </application>
</manifest>`;

const EXPECTED_TAG =
  '<activity android:name=".MainActivity" android:launchMode="singleTask" android:screenOrientation="unspecified"/>';

describe("patchOrientation", () => {
  it("sets a literal orientation on the main activity", () => {
    expect(patchOrientation(MANIFEST)).toContain(EXPECTED_TAG);
  });

  it("is idempotent", () => {
    const out = patchOrientation(MANIFEST);
    expect(patchOrientation(out)).toBe(out);
  });

  it("normalizes a resource reference left by the old string-resource version", () => {
    const pre = MANIFEST.replace(
      'android:launchMode="singleTask"',
      'android:launchMode="singleTask" android:screenOrientation="@string/app_orientation"',
    );
    const out = patchOrientation(pre);
    expect(out).toContain(EXPECTED_TAG);
    expect(out).not.toContain("@string/app_orientation");
    expect(patchOrientation(out)).toBe(out);
  });

  it("replaces a pre-existing orientation instead of duplicating it", () => {
    const pre = MANIFEST.replace(
      'android:launchMode="singleTask"',
      'android:launchMode="singleTask" android:screenOrientation="landscape"',
    );
    const out = patchOrientation(pre);
    expect(out).toContain(EXPECTED_TAG);
    expect(out).not.toContain("landscape");
    expect(patchOrientation(out)).toBe(out);
  });

  it("leaves other activities untouched", () => {
    const xml = MANIFEST.replace(
      "</application>",
      '<activity android:name=".OtherActivity" android:screenOrientation="landscape"/>\n  </application>',
    );
    const out = patchOrientation(xml);
    expect(out).toContain(
      '<activity android:name=".OtherActivity" android:screenOrientation="landscape"/>',
    );
    expect(out).toContain(EXPECTED_TAG);
  });

  it("returns the manifest unchanged when the main activity is missing", () => {
    const xml =
      '<manifest><application><activity android:name=".Other"/></application></manifest>';
    expect(patchOrientation(xml)).toBe(xml);
  });
});

const ACTIVITY = `package com.printninja.desktop

import android.os.Bundle
import app.tauri.bridge.TauriActivity

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
  }
}`;

describe("patchMainActivity", () => {
  it("locks phones and frees tablets in onCreate", () => {
    const out = patchMainActivity(ACTIVITY);
    expect(out).toContain("import android.content.pm.ActivityInfo");
    expect(out).toContain("smallestScreenWidthDp < 600");
    expect(out).toContain("ActivityInfo.SCREEN_ORIENTATION_PORTRAIT");
    expect(out).toContain("ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED");
    expect(out).toContain("super.onCreate(savedInstanceState)");
  });

  it("is idempotent", () => {
    const out = patchMainActivity(ACTIVITY);
    expect(patchMainActivity(out)).toBe(out);
  });

  it("does not duplicate the import when one is already present", () => {
    const src = ACTIVITY.replace(
      "import android.os.Bundle",
      "import android.content.pm.ActivityInfo\nimport android.os.Bundle",
    );
    const out = patchMainActivity(src);
    expect(out.match(/import android.content\.pm\.ActivityInfo/g)).toHaveLength(1);
  });

  it("returns the source unchanged when no onCreate anchor exists", () => {
    const src = "package com.printninja.desktop\n\nclass MainActivity";
    expect(patchMainActivity(src)).toBe(src);
  });
});
