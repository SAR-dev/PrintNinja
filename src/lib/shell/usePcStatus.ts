import { useCallback, useEffect, useRef, useState } from "react";
import { agent } from "@/lib/agent/commands";
import { describeError, PEER_REMOVED_RE, rawErrorMessage } from "@/lib/errors";
import { RENDER_PAIRS_KEY, parsePairs } from "@/lib/pairing";
import { isAndroid } from "@/lib/platform";
import { readSetting } from "@/lib/settings";

/**
 * Whether the paired PC can be reached right now, for the phone's banner.
 *
 * A phone renders nothing itself: every print is bought from the paired
 * PC. So a PC that is off, asleep or blocked by a firewall means every
 * print fails, and the person should see that before they tap Print, not
 * only in the failed job afterwards.
 *
 * - `none`: nothing to say (not a phone, nothing paired, or not checked yet)
 * - `up`:   at least one paired PC answered
 * - `down`: pairs exist and none answered; `reason` is the first PC's own
 *           message (already translated by `describeError`), `total` how
 *           many pairs share the outage (the banner stops blaming one PC
 *           when several are down)
 */
export type PcStatus =
  | { state: "none" }
  | { state: "up"; name: string }
  | {
      state: "down";
      name: string;
      reason: string;
      total: number;
      /** `unpaired` only when every failure is a removal; else `unreachable`. */
      kind: "unpaired" | "unreachable";
    };

/** One paired PC's probe result: `error` is null when it answered. */
export type PcCheck = {
  name: string;
  error: string | null;
  /** Set when `error` is set; meaningless otherwise. */
  kind: "unpaired" | "unreachable";
};

/**
 * Fold the probes of every paired PC into one status. One reachable PC is
 * enough (the pipeline picks the best one that answers), so the status is
 * `down` only when all of them failed, and it names the first.
 */
export function summarizePcChecks(checks: readonly PcCheck[]): PcStatus {
  if (checks.length === 0) return { state: "none" };
  const answered = checks.find((c) => c.error === null);
  if (answered) return { state: "up", name: answered.name };
  const first = checks[0];
  // No answer above means every check failed; unpaired only when every
  // failure is a removal.
  const kind = checks.every((c) => c.kind === "unpaired")
    ? ("unpaired" as const)
    : ("unreachable" as const);
  return {
    state: "down",
    name: first.name,
    reason: first.error ?? "",
    total: checks.length,
    kind,
  };
}

/**
 * Identity of one outage episode: the sorted names of the PCs that are
 * down, or null when anything answers. The banner mutes per episode —
 * dismissing hides this outage, and any change (a PC recovers, another
 * fails, a new `down` after an `up`) is a new key that shows again.
 * Sorted so probe completion order cannot flip it. An `unpaired` outage
 * and an `unreachable` one over the same PCs are different keys: muting
 * one must not mute the other.
 */
export function episodeKeyFor(checks: readonly PcCheck[]): string | null {
  if (checks.length === 0 || checks.some((c) => c.error === null)) return null;
  const scope = checks.every((c) => c.kind === "unpaired")
    ? "unpaired"
    : "down";
  return `${scope}:${[...checks.map((c) => c.name)].sort().join(",")}`;
}

/**
 * Probe every stored pair in parallel. Uses the same `peer_capabilities`
 * command as the Settings "Test" button, so the banner and the button can
 * never disagree about the same PC. Returns the folded status plus the
 * outage-episode key (`episodeKeyFor`): null unless every PC failed.
 */
export async function checkPairedPcs(): Promise<{
  status: PcStatus;
  key: string | null;
}> {
  const pairs = parsePairs(await readSetting(RENDER_PAIRS_KEY));
  const checks = await Promise.all(
    pairs.map(async (p): Promise<PcCheck> => {
      try {
        await agent("peer_capabilities", {
          host: p.host,
          port: p.port,
          secret: p.secret,
          name: p.name,
        });
        return { name: p.name, error: null, kind: "unreachable" };
      } catch (e) {
        // Classify the raw backend text, not the translation: a removal
        // in any language starts life as the Rust string above.
        const kind = PEER_REMOVED_RE.test(rawErrorMessage(e))
          ? ("unpaired" as const)
          : ("unreachable" as const);
        return { name: p.name, error: describeError(e), kind };
      }
    }),
  );
  return { status: summarizePcChecks(checks), key: episodeKeyFor(checks) };
}

/** How often to re-check while the app is on screen. */
export const PC_POLL_MS = 30_000;
/** Navigation and focus checks are skipped within this window. */
export const PC_MIN_GAP_MS = 5_000;

/**
 * Phone only: keeps `status` fresh. Checks on mount, every 30 s while the
 * app is visible, when it returns to the foreground, and when the network
 * comes back. `refresh` is the throttled check for route changes;
 * `recheck` is the forced one behind the banner's button.
 */
export function usePcStatus(): {
  status: PcStatus;
  /** Outage-episode key, null unless every paired PC failed. */
  episodeKey: string | null;
  recheck: () => void;
  refresh: () => void;
} {
  const [status, setStatus] = useState<PcStatus>({ state: "none" });
  const [episodeKey, setEpisodeKey] = useState<string | null>(null);
  const lastRun = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  // Skip-the-quiet-poll bookkeeping: while every PC is unpaired, the
  // 30 s tick only re-reads the (cheap, local) pairs list, and probes
  // the network only when it changed. A removal cannot heal by waiting.
  const unpairedRef = useRef(false);
  const pairsJsonRef = useRef<string | null>(null);

  const run = useCallback(async (force: boolean) => {
    if (!isAndroid() || inFlight.current) return;
    if (!force && Date.now() - lastRun.current < PC_MIN_GAP_MS) return;
    inFlight.current = true;
    lastRun.current = Date.now();
    try {
      const next = await checkPairedPcs();
      if (mounted.current) {
        setStatus(next.status);
        setEpisodeKey(next.key);
        unpairedRef.current =
          next.status.state === "down" && next.status.kind === "unpaired";
        pairsJsonRef.current = await readSetting(RENDER_PAIRS_KEY).catch(
          () => null,
        );
      }
    } catch {
      // Settings unreadable: say nothing rather than guess.
    } finally {
      inFlight.current = false;
    }
  }, []);

  const recheck = useCallback(() => void run(true), [run]);
  const refresh = useCallback(() => void run(false), [run]);

  useEffect(() => {
    if (!isAndroid()) return;
    mounted.current = true;
    void run(true);
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      // Unpaired PCs cannot recover by waiting: skip the network probe
      // unless the pairs list changed under us (re-pair, removal).
      if (unpairedRef.current) {
        void readSetting(RENDER_PAIRS_KEY)
          .catch(() => null)
          .then((raw) => {
            if (raw !== pairsJsonRef.current) void run(true);
          });
        return;
      }
      void run(true);
    }, PC_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void run(false);
    };
    const onOnline = () => void run(true);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [run]);

  return { status, episodeKey, recheck, refresh };
}
