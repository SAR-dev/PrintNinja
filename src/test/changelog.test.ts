import { describe, it, expect } from "vitest";
// biome-ignore format: single line keeps the ts-expect-error on the error line
// @ts-expect-error plain .mjs script without types
import { bumpChangelog, trimChangelog } from "../../scripts/lib/changelog.mjs";

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

const HISTORY = `# Changelog

## Unreleased

## [2026.1110.7] - 2026-11-10

- Newest.

## [2026.1110.6] - 2026-11-09

- Six.

## [2026.1110.5] - 2026-11-08

- Five.

## [2026.1110.4] - 2026-11-07

- Four.

## [2026.1110.3] - 2026-11-06

- Three.

## [2026.1110.2] - 2026-11-05

- Two.

## [2026.1110.1] - 2026-11-04

- Oldest.
`;

describe("trimChangelog", () => {
  it("keeps only the five newest dated sections", () => {
    const next = trimChangelog(HISTORY);
    expect(next).toContain("## [2026.1110.7]");
    expect(next).toContain("## [2026.1110.3]");
    expect(next).not.toContain("## [2026.1110.2]");
    expect(next).not.toContain("- Oldest.");
    expect(next).toContain("## Unreleased");
  });

  it("leaves a short history untouched and preserves CRLF", () => {
    const short =
      "# Changelog\r\n\r\n## Unreleased\r\n\r\n## [1.0.0] - 2026-01-01\r\n\r\n- One.\r\n";
    expect(trimChangelog(short)).toBe(short);
    expect(trimChangelog(HISTORY.replace(/\n/g, "\r\n"))).toContain(
      "\r\n## [2026.1110.7]",
    );
  });
});
