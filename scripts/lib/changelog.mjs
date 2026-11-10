// Changelog handling for `pnpm release` (scripts/release.mjs).
//
// The convention (see CHANGELOG.md): entries land under **Unreleased** as
// work happens; at a release the section is frozen under the new version's
// dated heading and a fresh empty Unreleased opens on top. Released
// sections are never edited again — they are the release notes.

/// The Unreleased section becomes the new version's heading.
///
/// Returns the updated text, or `null` when there is nothing to freeze:
/// no Unreleased section, or one without any list entries (an empty
/// version section would be noise). Line endings are preserved.
export function bumpChangelog(text, version, dateStr) {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(eol).map((l) => l.replace(/\r$/, ""));
	const start = lines.findIndex((l) => l.trim() === "## Unreleased");
	if (start < 0) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) {
			end = i;
			break;
		}
	}
	const body = lines.slice(start + 1, end);
	if (!body.some((l) => /^[-*] /.test(l.trim()))) return null;
	const heading = `## [${version}] - ${dateStr}`;
	return [...lines.slice(0, start), "## Unreleased", "", heading, ...lines.slice(start + 1)].join(eol);
}
