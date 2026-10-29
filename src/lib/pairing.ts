import type { RenderPair } from "@/lib/agent/types";
import { isAndroid } from "@/lib/android/background";
import { readSetting } from "@/lib/settings";

/** Settings keys backing shared rendering (see Automation → Phones). */
export const RENDER_PAIRS_KEY = "render_pairs";
export const RENDER_POLICY_KEY = "render_policy";

/**
 * Whether a PC is paired for shared rendering. On Android that is all it
 * takes: a phone always renders through its PC, so the stored policy is
 * ignored. Elsewhere both halves are required: pairs without the auto
 * policy never render (the pipeline only consults them when the policy is
 * auto), and auto with no pairs has nothing to ask. Reads through
 * `readSetting`, so the web preview falls back to localStorage like
 * everywhere else.
 */
export async function hasPairedProvider(): Promise<boolean> {
  try {
    const [pairsRaw, policy] = await Promise.all([
      readSetting(RENDER_PAIRS_KEY),
      readSetting(RENDER_POLICY_KEY),
    ]);
    if (policy !== "auto" && !isAndroid()) return false;
    const pairs = pairsRaw ? JSON.parse(pairsRaw) : [];
    return Array.isArray(pairs) && pairs.length > 0;
  } catch {
    return false;
  }
}

/**
 * Read the stored `render_pairs` JSON. Anything that is not a list of
 * objects with a string host and secret is dropped rather than trusted:
 * the setting can be edited by hand or left by an older version.
 */
export function parsePairs(raw: string | null): RenderPair[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is RenderPair =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as RenderPair).host === "string" &&
        typeof (p as RenderPair).secret === "string",
    );
  } catch {
    return [];
  }
}

/** Pairing-code alphabet: 32 symbols, no `0 O 1 I` (plan §3 decision 2). */
export const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Uppercase, strip dashes and whitespace (the dash is cosmetic). */
export function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/[-\s]/g, "");
}

/** Filter keystrokes: uppercase, drop spaces/dashes, drop characters
 * outside the alphabet. */
export function filterPairingInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[-\s]/g, "")
    .split("")
    .filter((c) => PAIRING_ALPHABET.includes(c))
    .join("")
    .slice(0, 8);
}

/** True when the normalized code is 8 alphabet characters. */
export function isCompletePairingCode(raw: string): boolean {
  const n = normalizePairingCode(raw);
  return (
    n.length === 8 && n.split("").every((c) => PAIRING_ALPHABET.includes(c))
  );
}

/** Display form `K7QM-4XPD` for an 8-character code. */
export function formatPairingCode(code: string): string {
  const n = normalizePairingCode(code);
  return n.length === 8 ? `${n.slice(0, 4)}-${n.slice(4)}` : code;
}

/**
 * Live display form for the pairing input: the hyphen appears as soon
 * as the first half is typed (`K7QM-4`), so the field always looks like
 * the code on the PC's screen. The stored value stays dashless —
 * `filterPairingInput` strips it on the way in.
 */
export function formatPairingCodeLive(raw: string): string {
  const n = normalizePairingCode(raw);
  return n.length <= 4 ? n : `${n.slice(0, 4)}-${n.slice(4, 8)}`;
}
