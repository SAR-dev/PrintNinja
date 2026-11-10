// Shared version logic for the release scripts (release.mjs, release-local.mjs,
// set-version.mjs). Pure functions plus one git-tag lookup; no side effects.
//
// Release versions are date based:  YYYY.MMDD.N
//
//   2026.1225.0   first release on 25 Dec 2026
//   2026.1225.1   second release the same day
//   2027.105.0    first release on 5 Jan 2027   (MMDD is a plain number)
//
// MMDD has no leading zero because semver (and Cargo) reject one. N is the
// release counter for that day, 0..99, picked automatically from existing tags.
//
// Two platform quirks make a bare date version unusable as-is, so the build
// config carries explicit overrides (written by withVersion below):
//
//   Windows MSI   first field max 255          -> bundle.windows.wix.version
//                 YYYY.MMDD.N becomes YY.MM.(DD*100+N), e.g. 26.12.2503
//   Android       Tauri derives versionCode as major*1e6 + minor*1e3 + patch,
//                 which goes DOWN across New Year (31 Dec: 2,027,231,000,
//                 1 Jan: 2,027,101,000) and Android rejects downgrades
//                                              -> bundle.android.versionCode
//                 YYMMDD*100+N, e.g. 26122503 (always increasing)

export const VERSION_RE = /^\d+\.\d+\.\d+$/;
export const MAX_RELEASES_PER_DAY = 100; // N is 0..99

export const parseVersion = (v) => v.split(".").map(Number);

export function cmpVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** "2026.1225" for the given (local) date. */
export function dateVersionPrefix(date = new Date()) {
  const mmdd = (date.getMonth() + 1) * 100 + date.getDate();
  return `${date.getFullYear()}.${mmdd}`;
}

/**
 * Split a date version into its parts, or return null when the string is not
 * a valid YYYY.MMDD.N date version (so 5.1.2 and 2026.1332.0 are both null).
 */
export function parseDateVersion(version) {
  if (typeof version !== "string" || !VERSION_RE.test(version)) return null;
  const [year, mmdd, n] = parseVersion(version);
  const month = Math.floor(mmdd / 100);
  const day = mmdd % 100;
  if (year < 2000 || year > 2099) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (n >= MAX_RELEASES_PER_DAY) return null;
  return { year, month, day, n };
}

export const isDateVersion = (version) => parseDateVersion(version) !== null;

/** Next free YYYY.MMDD.N for `date`, given versions that already exist. */
export function nextDateVersion({ date = new Date(), taken = [], current = "" } = {}) {
  const prefix = dateVersionPrefix(date);
  let max = -1;
  for (const v of [...taken, current]) {
    if (typeof v !== "string" || !v.startsWith(`${prefix}.`)) continue;
    const m = v.slice(prefix.length + 1).match(/^\d+$/);
    if (m) max = Math.max(max, Number(m[0]));
  }
  const n = max + 1;
  if (n >= MAX_RELEASES_PER_DAY) {
    throw new Error(`already ${MAX_RELEASES_PER_DAY} releases for ${prefix}; pass an explicit version`);
  }
  return `${prefix}.${n}`;
}

/**
 * Versions already released for a date prefix, read from local tags and from
 * origin. `git` is a function (...args) => stdout (trimmed) that throws on a
 * non-zero exit. Returns { versions, remoteOk }; when origin cannot be reached
 * only local tags are used and remoteOk is false.
 */
export function listTakenVersions(git, prefix) {
  const versions = new Set();
  const add = (name) => {
    const m = name.trim().match(/^(?:refs\/tags\/)?v(\d+\.\d+\.\d+)(?:\^\{\})?$/);
    if (m) versions.add(m[1]);
  };
  for (const line of git("tag", "-l", `v${prefix}.*`).split("\n")) add(line);
  let remoteOk = true;
  try {
    for (const line of git("ls-remote", "--tags", "origin", `refs/tags/v${prefix}.*`).split("\n")) {
      add(line.split("\t")[1] ?? "");
    }
  } catch {
    remoteOk = false;
  }
  return { versions: [...versions], remoteOk };
}

/** MSI ProductVersion for a date version: YYYY.MMDD.N -> YY.MM.(DD*100+N). */
export function msiVersion(version) {
  const d = parseDateVersion(version);
  if (!d) throw new Error(`${version} is not a YYYY.MMDD.N date version`);
  return `${d.year - 2000}.${d.month}.${d.day * 100 + d.n}`;
}

/** Android versionCode for a date version: YYMMDD*100+N (max ~99,123,199, limit 2.1e9). */
export function androidVersionCode(version) {
  const d = parseDateVersion(version);
  if (!d) throw new Error(`${version} is not a YYYY.MMDD.N date version`);
  return ((d.year - 2000) * 10000 + d.month * 100 + d.day) * 100 + d.n;
}

/**
 * Refuse versions the platform bundlers cannot represent. Date versions are
 * handled by the overrides; any other version needs a first field <= 255 for
 * the MSI (this is what stops `pnpm release 2026.5.0` from producing an
 * installer that fails to build).
 */
export function assertBuildable(version) {
  if (!VERSION_RE.test(version)) throw new Error(`"${version}" is not a version like 1.2.3`);
  if (isDateVersion(version)) return;
  const [major, minor, patch] = parseVersion(version);
  if (major > 255 || minor > 255 || patch > 65535) {
    throw new Error(
      `${version} cannot be built into a Windows MSI (fields are limited to 255.255.65535). ` +
        "Use a date version (YYYY.MMDD.N) or a smaller number.",
    );
  }
}

/**
 * src-tauri/tauri.conf.json with `version` set and the platform overrides
 * kept in step: written for a date version, removed otherwise. Only the two
 * keys managed here are touched; everything else keeps its value and order.
 */
export function withVersion(text, version) {
  const crlf = text.includes("\r\n");
  const conf = JSON.parse(text);
  conf.version = version;

  const dated = isDateVersion(version);
  const bundle = (conf.bundle ??= {});

  if (dated) {
    ((bundle.windows ??= {}).wix ??= {}).version = msiVersion(version);
    (bundle.android ??= {}).versionCode = androidVersionCode(version);
  } else {
    if (bundle.windows?.wix) {
      delete bundle.windows.wix.version;
      if (Object.keys(bundle.windows.wix).length === 0) delete bundle.windows.wix;
      if (Object.keys(bundle.windows).length === 0) delete bundle.windows;
    }
    if (bundle.android) {
      delete bundle.android.versionCode;
      if (Object.keys(bundle.android).length === 0) delete bundle.android;
    }
  }

  let out = `${JSON.stringify(conf, null, 2)}${text.endsWith("\n") ? "\n" : ""}`;
  if (crlf) out = out.replace(/\n/g, "\r\n");
  return out;
}

/** Problems with the platform overrides in a tauri.conf.json text (empty = fine). */
export function platformVersionProblems(text, version) {
  const bundle = JSON.parse(text).bundle ?? {};
  const wix = bundle.windows?.wix?.version;
  const code = bundle.android?.versionCode;
  const problems = [];
  if (isDateVersion(version)) {
    if (wix !== msiVersion(version)) problems.push(`bundle.windows.wix.version is ${wix ?? "(missing)"}, want ${msiVersion(version)}`);
    if (code !== androidVersionCode(version)) problems.push(`bundle.android.versionCode is ${code ?? "(missing)"}, want ${androidVersionCode(version)}`);
  } else {
    if (wix !== undefined) problems.push(`bundle.windows.wix.version is set (${wix}) but ${version} is not a date version`);
    if (code !== undefined) problems.push(`bundle.android.versionCode is set (${code}) but ${version} is not a date version`);
  }
  return problems;
}

/** Validate a --label value (goes into tag / commit / release title). */
export function checkLabel(label) {
  if (typeof label !== "string" || label.trim() === "") return "--label needs a value";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters on purpose
  if (/[\u0000-\u001f\u007f]/.test(label)) return "--label must be a single line of plain text";
  if (label.length > 60) return "--label is limited to 60 characters";
  return "";
}
