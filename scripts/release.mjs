#!/usr/bin/env node
// Release helper. Sets the version in every manifest (the same files release-local checks),
// commits, and creates an annotated tag. Cross-platform: needs only Node + git.
//
//   pnpm release [--label TEXT] [--push] [--dry-run]
//   pnpm release X.Y.Z [--push] [--dry-run]        (emergency override)
//
// The version is picked automatically from the date: YYYY.MMDD.N, where N counts
// the releases of that day (2026.1225.0, 2026.1225.1, ...; see scripts/lib/version.mjs).
//
// Without --push nothing leaves your machine. There is no hosted CI: pushing
// the tag publishes the tag only. Build and attach installers with
// `node scripts/release-local.mjs X.Y.Z --push`.
//
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	VERSION_RE,
	androidVersionCode,
	assertBuildable,
	checkLabel,
	cmpVersions as cmp,
	dateVersionPrefix,
	isDateVersion,
	listTakenVersions,
	msiVersion,
	nextDateVersion,
	platformVersionProblems,
	withVersion,
} from "./lib/version.mjs";
import { bumpChangelog } from "./lib/changelog.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = {
	pkg: "package.json",
	tauri: "src-tauri/tauri.conf.json",
	cargo: "src-tauri/Cargo.toml",
	lock: "src-tauri/Cargo.lock",
	layout: "src/components/Layout.tsx",
	readme: "README.md",
	// Frozen by `bumpChangelog` below, not by `applyVersion`.
	changelog: "CHANGELOG.md",
};
const RELEASE_BRANCH = "main";

// ---- helpers ---------------------------------------------------------------

const read = (f) => readFileSync(join(ROOT, f), "utf8");
const write = (f, s) => writeFileSync(join(ROOT, f), s);
const git = (...args) =>
	execFileSync("git", args, {
		cwd: ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

function die(msg) {
	console.error(`\nError: ${msg}`);
	process.exit(1);
}

function usage() {
	console.log(`Usage: pnpm release [--label TEXT] [--push] [--dry-run]
       pnpm release X.Y.Z [--push] [--dry-run]

  (no version)        use today's date: YYYY.MMDD.N, N = next free release number of the day
  X.Y.Z               set an exact version (must be higher than the current one)
  --label TEXT        note kept in the tag message and commit body (for example: major, hotfix)
  --push              also push ${RELEASE_BRANCH} and the tag (tag only, no builds)
  --dry-run           show what would happen, change nothing
  --help              show this help`);
}

// ---- reading versions (same sources CI's version-check reads) --------------

// Version / name of the [package] table only (not [lib], [dependencies], ...).
function cargoPackageField(text, field) {
	let inPackage = false;
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (/^\[.*]$/.test(t)) {
			inPackage = t === "[package]";
			continue;
		}
		const m = inPackage && t.match(new RegExp(`^${field}\\s*=\\s*"([^"]+)"`));
		if (m) return m[1];
	}
	return "";
}

// Cargo.lock entry of this crate, found line by line (no regex escapes to get
// mangled when the file is copied around). Returns the indexes of its version lines.
function lockVersionLines(lines, crate) {
	const hits = [];
	lines.forEach((line, i) => {
		if (
			line.trim() === "[[package]]" &&
			(lines[i + 1] || "").trim() === `name = "${crate}"` &&
			/^version\s*=/.test((lines[i + 2] || "").trim())
		) {
			hits.push(i + 2);
		}
	});
	return hits;
}

function bumpCargoLock(text, version, crate) {
	const lines = text.split("\n"); // keep any \r so line endings are preserved
	const hits = lockVersionLines(lines, crate);
	if (hits.length !== 1) die(`${FILES.lock}: expected one "${crate}" entry, found ${hits.length}`);
	lines[hits[0]] = lines[hits[0]].replace(/^(\s*version\s*=\s*")[^"]+(")/, (_, a, b) => `${a}${version}${b}`);
	return lines.join("\n");
}

function readVersions(crate) {
	const lockLines = read(FILES.lock).split("\n");
	const lockHits = lockVersionLines(lockLines, crate);
	const lock = lockHits.length === 1 ? lockLines[lockHits[0]].match(/"([^"]+)"/) : null;
	const layout = read(FILES.layout).match(/"v(\d+\.\d+\.\d+)"/);
	const readme = read(FILES.readme).match(/badge\/version-(\d+\.\d+\.\d+)-e43636/);
	return {
		"package.json": JSON.parse(read(FILES.pkg)).version,
		"tauri.conf.json": JSON.parse(read(FILES.tauri)).version,
		"Cargo.toml": cargoPackageField(read(FILES.cargo), "version"),
		"Cargo.lock": lock ? lock[1] : "",
		"Layout.tsx": layout ? layout[1] : "",
		"README.md": readme ? readme[1] : "",
	};
}

// ---- writing versions ------------------------------------------------------

// Replace group 1 + <version> + group 2, and insist on exactly one match so a
// changed file layout fails loudly instead of silently skipping a manifest.
function replaceOnce(text, re, version, file) {
	const count = (text.match(new RegExp(re.source, `${re.flags}g`)) || []).length;
	if (count !== 1) {
		die(`${file}: expected exactly one version to update, found ${count}`);
	}
	return text.replace(re, (_, a, b) => `${a}${version}${b}`);
}

function bumpCargoToml(text, version) {
	const lines = text.split("\n"); // keep any \r so line endings are preserved
	let inPackage = false;
	let done = 0;
	lines.forEach((line, i) => {
		const t = line.trim();
		if (/^\[.*]$/.test(t)) {
			inPackage = t === "[package]";
		} else if (inPackage && /^version\s*=/.test(t)) {
			lines[i] = line.replace(/^(\s*version\s*=\s*")[^"]+(")/, (_, a, b) => `${a}${version}${b}`);
			done++;
		}
	});
	if (done !== 1) die(`${FILES.cargo}: expected one [package] version, found ${done}`);
	return lines.join("\n");
}

function applyVersion(version, crate) {
	write(FILES.pkg, replaceOnce(read(FILES.pkg), /^(\s*"version"\s*:\s*")[^"]+(")/m, version, FILES.pkg));
	write(FILES.tauri, withVersion(read(FILES.tauri), version));
	write(FILES.cargo, bumpCargoToml(read(FILES.cargo), version));
	write(FILES.lock, bumpCargoLock(read(FILES.lock), version, crate));
	write(FILES.layout, replaceOnce(read(FILES.layout), /("v)\d+\.\d+\.\d+(")/, version, FILES.layout));
	write(FILES.readme, replaceOnce(read(FILES.readme), /(badge\/version-)\d+\.\d+\.\d+(-e43636)/, version, FILES.readme));
}

// ---- main ------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	usage();
	process.exit(0);
}
const push = args.includes("--push");
const dryRun = args.includes("--dry-run");
let label = null;
const positional = [];
const unknown = [];
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--push" || a === "--dry-run") continue;
	if (a === "--label") label = args[++i] ?? "";
	else if (a.startsWith("--label=")) label = a.slice("--label=".length);
	else if (a.startsWith("--")) unknown.push(a);
	else positional.push(a);
}
if (unknown.length) {
	usage();
	die(`unknown option: ${unknown.join(", ")}`);
}
if (label !== null) {
	const labelProblem = checkLabel(label);
	if (labelProblem) die(labelProblem);
	label = label.trim();
}
if (positional.length > 1) {
	usage();
	die("give at most one version (X.Y.Z), or none to use today's date");
}
if (["patch", "minor", "major"].includes(positional[0])) {
	die(
		`"${positional[0]}" is no longer supported: versions now come from the date (YYYY.MMDD.N).\n` +
			`Run  pnpm release  for the next date version; mark a big release with  --label ${positional[0]}.`,
	);
}

const crate = cargoPackageField(read(FILES.cargo), "name");
if (!crate) die(`could not read the crate name from ${FILES.cargo}`);

const before = readVersions(crate);
const current = before["package.json"];
const mismatched = Object.entries(before).filter(([, v]) => v !== current);
if (mismatched.length) {
	die(
		`versions are out of sync before bumping:\n${Object.entries(before)
			.map(([f, v]) => `  ${f.padEnd(16)} ${v || "(not found)"}`)
			.join("\n")}\nFix them first.`,
	);
}

let version;
if (positional.length === 0) {
	const { versions, remoteOk } = listTakenVersions(git, dateVersionPrefix());
	if (!remoteOk) {
		console.warn("Warning: could not list tags on origin, picked the release number N from local tags only.");
	}
	try {
		version = nextDateVersion({ taken: versions, current });
	} catch (err) {
		die(err.message);
	}
} else {
	version = positional[0];
	if (!VERSION_RE.test(version)) {
		die(`"${version}" is not a version like 1.2.3 (or leave it out to use today's date)`);
	}
}
try {
	assertBuildable(version);
} catch (err) {
	die(err.message);
}
const tag = `v${version}`;
const labelSuffix = label ? ` (${label})` : "";

// Checks. In a dry run they are reported; otherwise they stop the release.
const problems = [];
if (cmp(version, current) <= 0) problems.push(`${version} is not higher than the current version ${current}`);

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== RELEASE_BRANCH) {
	problems.push(`on branch "${branch}"; releases must be tagged from ${RELEASE_BRANCH} (release-local requires main)`);
}

const dirty = git("status", "--porcelain");
if (dirty) problems.push(`working tree is not clean:\n${dirty.replace(/^/gm, "    ")}`);

if (git("tag", "-l", tag)) problems.push(`tag ${tag} already exists locally`);

try {
	git("fetch", "origin", RELEASE_BRANCH, "--quiet");
	const behind = Number(git("rev-list", "--count", `HEAD..origin/${RELEASE_BRANCH}`));
	if (behind > 0) problems.push(`local ${RELEASE_BRANCH} is ${behind} commit(s) behind origin; pull first`);
	if (git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) problems.push(`tag ${tag} already exists on origin`);
} catch {
	console.warn("Warning: could not reach origin, skipped the up-to-date and remote tag checks.");
}

const dateStr = new Date().toISOString().slice(0, 10);
const changelogNext = bumpChangelog(read(FILES.changelog), version, dateStr);

console.log(`=== Release ${crate} ${current} -> ${version} (${tag})${labelSuffix} ===`);
console.log(Object.values(FILES).map((f) => `  ${f}`).join("\n"));
if (isDateVersion(version)) {
	console.log(`  (Windows MSI version ${msiVersion(version)}, Android versionCode ${androidVersionCode(version)}, both in ${FILES.tauri})`);
}
if (changelogNext) {
	console.log(`  (${FILES.changelog}: "## Unreleased" becomes "## [${version}] - ${dateStr}", the rest of the section is frozen)`);
}

if (dryRun) {
	if (problems.length) console.log(`\nA real run would be refused:\n- ${problems.join("\n- ")}`);
	else console.log("\nDry run: all checks pass, nothing changed.");
	process.exit(problems.length ? 1 : 0);
}
if (problems.length) die(`cannot release:\n- ${problems.join("\n- ")}`);

try {
	applyVersion(version, crate);
	// Freeze the changelog in the same commit as the version bump, so the
	// release notes travel with the tag.
	if (changelogNext) write(FILES.changelog, changelogNext);

	// Same comparison release-local makes, so a bad bump is caught here.
	const after = readVersions(crate);
	const bad = Object.entries(after).filter(([, v]) => v !== version);
	if (bad.length) {
		throw new Error(`version mismatch after bump: ${bad.map(([f, v]) => `${f}=${v || "?"}`).join(", ")}`);
	}
	const platform = platformVersionProblems(read(FILES.tauri), version);
	if (platform.length) throw new Error(`platform version overrides are wrong: ${platform.join("; ")}`);

	git("add", "--", ...Object.values(FILES));
	git("commit", "-m", `release: ${tag}${labelSuffix}`, "-m", `Release ${crate} ${version}${label ? `\n\nLabel: ${label}` : ""}`);
	git("tag", "-a", tag, "-m", `release: ${tag}${labelSuffix}`);
} catch (err) {
	console.error(`\nError: ${err.stderr || err.message}`);
	console.error(`Undo with:  git reset --hard HEAD  (and  git tag -d ${tag}  if the tag was created)`);
	process.exit(1);
}

console.log(`\n[ok] committed "release: ${tag}" and tagged ${tag}`);

if (push) {
	git("push", "--atomic", "origin", RELEASE_BRANCH, tag);
	console.log(`[ok] pushed ${RELEASE_BRANCH} and ${tag}. Build installers with: node scripts/release-local.mjs ${tag.slice(1)} --push`);
} else {
	console.log(`\nNext (publishes the tag only):\n  git push --atomic origin ${RELEASE_BRANCH} ${tag}`);
}
