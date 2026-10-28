import { describe, it, expect } from "vitest";
// biome-ignore format: single line keeps the ts-expect-error on the error line
// @ts-expect-error plain .mjs script without types
import { patchBuildGradle, keyPropertiesContent } from "../../scripts/patch-android-signing.mjs";

const SAMPLE = `android {
    defaultConfig {
        applicationId = "com.printninja.desktop"
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
        }
        getByName("release") {
            isMinifyEnabled = false
        }
    }
}`;

const OLD_FORMAT = `android {
    // printninja-signing: stable debug key (see scripts/patch-android-signing.mjs)
    signingConfigs {
        getByName("debug") {
            val keyProps = Properties().apply {
                val keyFile = file("key.properties")
                if (keyFile.exists()) {
                    keyFile.inputStream().use { load(it) }
                }
            }
            storeFile = file(keyProps.getProperty("storeFile", "printninja.keystore"))
            storePassword = keyProps.getProperty("storePassword")
            keyAlias = keyProps.getProperty("keyAlias")
            keyPassword = keyProps.getProperty("keyPassword")
        }
    }
    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("debug")
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
        }
        getByName("release") {
            isMinifyEnabled = false
        }
    }
}`;

function buildTypeBlock(out: string, variant: string): string {
  const buildTypesAt = (out as string).indexOf("buildTypes {");
  const at = (out as string).indexOf(`getByName("${variant}") {`, buildTypesAt);
  const end = (out as string).indexOf("\n        }", at);
  return (out as string).slice(at, end);
}

describe("patch-android-signing", () => {
  const out = patchBuildGradle(SAMPLE) as string;
  it("adds debug and release signingConfigs fed by key.properties", () => {
    expect(out).toContain("signingConfigs {");
    expect(out).toContain('file("key.properties")');
    expect(out).toContain(
      'file(keyProps.getProperty("storeFile", "printninja.keystore"))',
    );
    expect(out).toContain('getByName("debug")');
    expect(out).toContain('create("release")');
    // The buildType still reads the config with getByName (fine once
    // create()d above); the signing block itself must not use it.
    const configs = out.slice(
      out.indexOf("signingConfigs {"),
      out.indexOf("buildTypes {"),
    );
    expect(configs).not.toContain('getByName("release")');
  });
  it("points both buildTypes at the stable key, inside buildTypes", () => {
    for (const variant of ["debug", "release"]) {
      const line = `signingConfig = signingConfigs.getByName("${variant}")`;
      expect(out).toContain(line);
      const buildTypesAt = out.indexOf("buildTypes {");
      const configsAt = out.indexOf("signingConfigs {");
      const lineAt = out.indexOf(line, buildTypesAt);
      expect(configsAt).toBeLessThan(buildTypesAt);
      expect(lineAt).toBeGreaterThan(buildTypesAt);
    }
  });
  it("keeps cleartext allowed on release, like debug", () => {
    const release = buildTypeBlock(out, "release");
    expect(release).toContain(
      'manifestPlaceholders["usesCleartextTraffic"] = "true"',
    );
    // ...and does not touch the signing config block itself.
    const configs = out.slice(
      out.indexOf("signingConfigs {"),
      out.indexOf("buildTypes {"),
    );
    expect(configs).not.toContain("usesCleartextTraffic");
  });
  it("upgrades files patched by the older debug-only script", () => {
    const upgraded = patchBuildGradle(OLD_FORMAT) as string;
    expect(upgraded).toContain('signingConfigs.getByName("release")');
    expect(upgraded).toContain('create("release")');
    expect(buildTypeBlock(upgraded, "release")).toContain(
      'manifestPlaceholders["usesCleartextTraffic"] = "true"',
    );
    // Debug wiring survives the upgrade untouched (exactly once).
    expect(
      upgraded.split('signingConfig = signingConfigs.getByName("debug")')
        .length - 1,
    ).toBe(1);
    expect(patchBuildGradle(upgraded)).toBe(upgraded);
  });
  it("normalizes getByName to create inside signingConfigs", () => {
    const good = patchBuildGradle(SAMPLE) as string;
    const bad = good.replace('create("release")', 'getByName("release")');
    expect(bad).not.toBe(good);
    expect(patchBuildGradle(bad)).toBe(good);
  });
  it("is idempotent", () => {
    expect(patchBuildGradle(out)).toBe(out);
  });
  it("renders key.properties for the shared keystore", () => {
    const props = keyPropertiesContent("s3cret", "printninja") as string;
    expect(props).toContain("storeFile=printninja.keystore");
    expect(props).toContain("storePassword=s3cret");
    expect(props).toContain("keyAlias=printninja");
    expect(props).toContain("keyPassword=s3cret");
  });
});
