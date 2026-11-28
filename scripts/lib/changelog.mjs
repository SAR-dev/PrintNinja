// Changelog handling for `pnpm release` (scripts/release.mjs).
//
// The convention (see docs/CHANGELOG.md): entries land under **Unreleased** as
// work happens; at a release the section is frozen under the new version's
// dated heading and a fresh empty Unreleased opens on top. Released
// sections are never edited again — they are the release notes.

/// The Unreleased section becomes the new version's heading.
///
/// Returns the updated text, or `null` when there is nothing to freeze:
/// no Unreleased section, or one without any list entries (an empty
/// version section would be noise). Line endings are preserved.
export const MAX_RELEASE_SECTIONS = 5;

/**
 * Keep only the newest `max` dated release sections. The intro, the
 * Unreleased section and the most recent releases stay; everything from
 * the (max+1)th heading onward is dropped. Existing line endings are kept.
 */
export function trimChangelog(text, max = MAX_RELEASE_SECTIONS) {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(eol).map((l) => l.replace(/\r$/, ""));
	const starts = [];
	for (let i = 0; i < lines.length; i++) {
		if (/^## \[\d/.test(lines[i])) starts.push(i);
	}
	if (starts.length <= max) return text;
	const out = lines.slice(0, starts[max]);
	while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
	const kept = out.join(eol);
	return text.endsWith(eol) ? `${kept}${eol}` : kept;
}

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
