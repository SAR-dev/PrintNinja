import { useCallback, useEffect, useState } from "react";
import { agent } from "@/lib/agent/commands";
import type { RenderEngineStatus } from "@/lib/agent/types";

/**
 * Is the print browser installed? Read once at start-up, again on demand
 * (the dialog's "Check again"), and again whenever the window regains focus
 * while it is missing — the usual flow is "install in a terminal, switch
 * back", and the dialog should notice without a click.
 *
 * A failed read is "unknown", never "missing": a browser (no backend) or a
 * transient IPC error must not raise a false alarm.
 */
export function useRenderEngine(): {
  status: RenderEngineStatus | null;
  checking: boolean;
  recheck: () => Promise<RenderEngineStatus | null>;
} {
  const [status, setStatus] = useState<RenderEngineStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      const s = (await agent("get_render_engine_status", {})) ?? null;
      setStatus(s);
      return s;
    } catch {
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  const missing = !!status && !status.available;
  useEffect(() => {
    if (!missing) return;
    const onFocus = () => void recheck();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [missing, recheck]);

  return { status, checking, recheck };
}
