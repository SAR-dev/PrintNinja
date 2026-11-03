import { describe, it, expect } from "vitest";
// biome-ignore format: single line keeps the ts-expect-error on the error line
// @ts-expect-error plain .mjs script without types
import { patchOrientation, orientationFiles } from "../../scripts/patch-android-orientation.mjs";

const MANIFEST = `<manifest>
  <application>
    <activity android:name=".MainActivity" android:launchMode="singleTask"/>
  </application>
</manifest>`;

const EXPECTED_TAG =
  '<activity android:name=".MainActivity" android:launchMode="singleTask" android:screenOrientation="@string/app_orientation"/>';

describe("patchOrientation", () => {
  it("adds the orientation attribute to the main activity", () => {
    expect(patchOrientation(MANIFEST)).toContain(EXPECTED_TAG);
  });

  it("is idempotent", () => {
    const out = patchOrientation(MANIFEST);
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

describe("orientationFiles", () => {
  it("locks phones and frees tablets", () => {
    const files = orientationFiles();
    expect(files["values/orientation.xml"]).toContain(
      '<string name="app_orientation">portrait</string>',
    );
    expect(files["values-sw600dp/orientation.xml"]).toContain(
      '<string name="app_orientation">unspecified</string>',
    );
  });
});
