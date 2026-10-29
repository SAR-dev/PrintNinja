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
 * Normalize a paired host for identity comparison: cosmetic differences
 * (`PC.local` vs `pc.local`, `[::1]`, a trailing dot) must not fork one
 * machine into two pairs.
 */
export function normalizePairHost(host: string): string {
  return host
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
}

/** Address key: same key means the same endpoint, whatever the provider id. */
export function pairAddressKey(host: string, port: number): string {
  return `${normalizePairHost(host)}:${port}`;
}

export interface PhonePairMerge {
  pairs: RenderPair[];
  /** A differently-identified entry died (reset/reinstalled PC). */
  replacedStale: boolean;
}

/**
 * Merge a fresh pair into the stored list (mirrors Rust `merge_pair`):
 * same provider (moved address) or same address (new provider id)
 * replaces. The caller toasts when `replacedStale` is set.
 */
export function mergePhonePair(
  pairs: RenderPair[],
  next: RenderPair,
): PhonePairMerge {
  const key = pairAddressKey(next.host, next.port ?? 0);
  let replacedStale = false;
  const kept = pairs.filter((e) => {
    const sameProvider =
      !!next.provider_id && e.provider_id === next.provider_id;
    const sameAddress = pairAddressKey(e.host, e.port ?? 0) === key;
    const same = sameProvider || sameAddress;
    if (same && e.provider_id !== next.provider_id) replacedStale = true;
    return !same;
  });
  return { pairs: [...kept, next], replacedStale };
}

/** Groups sharing one normalized address (length > 1): the duplicates. */
export function duplicatePairGroups(pairs: RenderPair[]): RenderPair[][] {
  const by = new Map<string, RenderPair[]>();
  for (const p of pairs) {
    const k = pairAddressKey(p.host, p.port ?? 0);
    by.set(k, [...(by.get(k) ?? []), p]);
  }
  return [...by.values()].filter((g) => g.length > 1);
}
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

/** Uppercase and strip whitespace. Dashes are neither stripped nor
 * accepted: a dash fails the format check. */
export function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/\s/g, "");
}

/** Filter keystrokes: uppercase, drop whitespace, drop characters
 * outside the alphabet — dashes never reach the field. */
export function filterPairingInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\s/g, "")
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
