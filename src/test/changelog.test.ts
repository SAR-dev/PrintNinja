import { describe, it, expect } from "vitest";
// biome-ignore format: single line keeps the ts-expect-error on the error line
// @ts-expect-error plain .mjs script without types
import { bumpChangelog } from "../../scripts/lib/changelog.mjs";

const DOC = `# Changelog

## Unreleased

### Added

- **New thing.** It works.

### Changed

- **Old thing.** Renamed.

## [2026.1110.2] - 2026-11-10

### Added

- Earlier release.
`;

describe("bumpChangelog", () => {
  it("freezes Unreleased under the new version heading", () => {
    const next = bumpChangelog(DOC, "2026.1110.3", "2026-11-12");
    expect(next).toBe(
      `# Changelog

## Unreleased

## [2026.1110.3] - 2026-11-12

### Added

- **New thing.** It works.

### Changed

- **Old thing.** Renamed.

## [2026.1110.2] - 2026-11-10

### Added

- Earlier release.
`,
    );
  });

  it("handles Unreleased as the last section", () => {
    const doc = `# Changelog

## Unreleased

### Fixed

- A bug.
`;
    const next = bumpChangelog(doc, "2026.1110.3", "2026-11-12");
    expect(next).toBe(
      `# Changelog

## Unreleased

## [2026.1110.3] - 2026-11-12

### Fixed

- A bug.
`,
    );
  });

  it("leaves an entry-less Unreleased alone", () => {
    const doc = `# Changelog

## Unreleased

## [2026.1110.2] - 2026-11-10

### Added

- Earlier release.
`;
    expect(bumpChangelog(doc, "2026.1110.3", "2026-11-12")).toBeNull();
  });

  it("returns null when there is no Unreleased section", () => {
    expect(
      bumpChangelog("## [1.0.0] - 2026-01-01\n", "1.0.1", "2026-01-02"),
    ).toBeNull();
  });

  it("keeps CRLF line endings", () => {
    const doc = "# Changelog\r\n\r\n## Unreleased\r\n\r\n- A fix.\r\n";
    const next = bumpChangelog(doc, "2026.1110.3", "2026-11-12");
    expect(next).toBe(
      "# Changelog\r\n\r\n## Unreleased\r\n\r\n## [2026.1110.3] - 2026-11-12\r\n\r\n- A fix.\r\n",
    );
  });
});
