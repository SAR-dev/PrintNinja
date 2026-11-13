import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Download, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { openExternalUrl } from "@/lib/appUpdate";
import { notifyInfo, notifySuccess } from "@/lib/notify";
import {
  CHROME_DOWNLOAD_URL,
  EDGE_DOWNLOAD_URL,
  WINDOWS_WINGET_COMMAND,
  linuxInstall,
  linuxOverrideCommand,
  needsBrowserHelp,
} from "@/lib/render/engineHelp";
import { useRenderEngine } from "@/lib/render/useRenderEngine";
import { agent } from "@/lib/agent/commands";
import type { BrowserShellStatus, RenderEngineStatus } from "@/lib/agent/types";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function Command({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div className="relative">
      <pre
        data-testid="engine-command"
        className="overflow-x-auto rounded-md border bg-muted p-3 pr-11 font-mono text-xs leading-relaxed"
      >
        {text}
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-1 top-1 h-8 w-8"
        aria-label={t("engine.copy")}
        title={t("engine.copy")}
        onClick={() => void copyText(text)}
      >
        <Copy className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}

function LinkButton({ url, label }: { url: string; label: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void openExternalUrl(url)}
    >
      <ExternalLink className="mr-1.5 h-4 w-4" aria-hidden="true" />
      {label}
    </Button>
  );
}

/** The opt-in headless browser (step 3 on Windows): status, download with
 * live progress, and removal. Nothing is downloaded without a press. */
function ShellStep({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const [shell, setShell] = useState<BrowserShellStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setShell((await agent("browser_shell_status", {})) ?? null);
    } catch {
      setShell(null);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const download = useCallback(async () => {
    setBusy(true);
    setProgress(null);
    let unlisten: (() => void) | null = null;
    try {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<{ done: number; total: number }>(
          "browser-shell-progress",
          (e) => setProgress(e.payload),
        );
      } catch {
        /* no Tauri event bridge (web preview / tests): no live progress */
      }
      await agent("browser_shell_download", {});
    } catch {
      /* the state row carries the error; the refresh below shows it */
    } finally {
      unlisten?.();
      setBusy(false);
      setProgress(null);
      await refresh();
    }
  }, [refresh]);

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      await agent("browser_shell_remove", {});
    } catch {
      /* status below reflects what the backend reports */
    } finally {
      setBusy(false);
      await refresh();
    }
  }, [refresh]);

  return (
    <Step n={3} title={t("engine.win_step_shell")}>
      <p className="text-sm text-muted-foreground">
        {t("engine.win_shell_hint")}
      </p>
      {shell?.state === "ready" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p data-testid="engine-shell-ready" className="text-sm text-success">
            {t("engine.win_shell_ready", { version: shell.version })}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="engine-shell-remove"
            disabled={busy}
            onClick={() => void remove()}
          >
            <Trash2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t("engine.win_shell_remove")}
          </Button>
        </div>
      ) : busy ? (
        <p data-testid="engine-shell-downloading" className="text-sm">
          {t("engine.win_shell_downloading", {
            done: progress ? Math.floor(progress.done / 1048576) : 0,
            total: progress
              ? Math.max(1, Math.floor(progress.total / 1048576))
              : 0,
          })}
        </p>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="engine-shell-download"
          onClick={() => void download()}
        >
          <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
          {t("engine.win_shell_download")}
        </Button>
      )}
      {shell?.state === "error" && shell.error && (
        <p
          data-testid="engine-shell-error"
          className="break-words text-xs text-destructive"
        >
          {t("engine.win_shell_error", { error: shell.error })}
        </p>
      )}
    </Step>
  );
}

function WindowsSteps({
  status,
  open,
}: {
  status: RenderEngineStatus;
  open: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ol className="space-y-4">
      <Step n={1} title={t("engine.win_step_install")}>
        <p className="text-sm text-muted-foreground">
          {t("engine.win_install_hint")}
        </p>
        <LinkButton url={EDGE_DOWNLOAD_URL} label={t("engine.win_download")} />
        <p className="text-sm text-muted-foreground">
          {t("engine.win_winget_hint")}
        </p>
        <Command text={WINDOWS_WINGET_COMMAND} />
      </Step>
      <Step n={2} title={t("engine.win_step_location")}>
        <p className="text-sm text-muted-foreground">
          {t("engine.win_location_hint")}
        </p>
        <ul className="space-y-1 font-mono text-xs">
          {status.searched.map((p) => (
            <li key={p} className="break-all">
              {p}
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          {t("engine.win_webview_note")}
        </p>
      </Step>
      <ShellStep open={open} />
      <Step n={4} title={t("engine.step_recheck")}>
        <p className="text-sm text-muted-foreground">
          {t("engine.step_recheck_hint")}
        </p>
      </Step>
    </ol>
  );
}

function LinuxSteps({ status }: { status: RenderEngineStatus }) {
  const { t } = useTranslation();
  const install = linuxInstall(status.distro);
  return (
    <ol className="space-y-4">
      <Step n={1} title={t("engine.linux_step_install")}>
        <p className="text-sm text-muted-foreground">
          {status.distro_name
            ? t("engine.linux_detected", { name: status.distro_name })
            : t("engine.linux_unknown_distro")}
        </p>
        <Command text={install.command} />
        {install.avoidSnap && (
          <p className="text-sm text-muted-foreground">
            {t("engine.linux_avoid_snap")}
          </p>
        )}
        {install.family === "generic" && (
          <LinkButton
            url={CHROME_DOWNLOAD_URL}
            label={t("engine.linux_download")}
          />
        )}
        {status.appimage && (
          <p className="text-sm text-muted-foreground">
            {t("engine.linux_appimage")}
          </p>
        )}
      </Step>
      <Step n={2} title={t("engine.linux_step_path")}>
        <p className="text-sm text-muted-foreground">
          {t("engine.linux_path_hint")}
        </p>
        <p className="break-all font-mono text-xs">
          {status.searched.join(", ")}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("engine.linux_override_hint")}
        </p>
        <Command text={linuxOverrideCommand(status.appimage)} />
      </Step>
      <Step n={3} title={t("engine.step_recheck")}>
        <p className="text-sm text-muted-foreground">
          {t("engine.step_recheck_hint")}
        </p>
      </Step>
    </ol>
  );
}

/**
 * The "no print browser" notice: a top-bar badge plus a modal with the exact
 * steps to fix it. Renders nothing while the browser is installed (or while
 * it is unknown, e.g. in a plain browser tab).
 *
 * The modal opens by itself once per app session — printing is what breaks,
 * and a toast would be gone before anyone reads a command — and the badge
 * reopens it after it is dismissed.
 */
export function RenderEngineNotice() {
  const { t } = useTranslation();
  const { status, checking, recheck } = useRenderEngine();
  const [open, setOpen] = useState(false);
  const announced = useRef(false);
  const help = needsBrowserHelp(status);

  useEffect(() => {
    if (help && !announced.current) {
      announced.current = true;
      setOpen(true);
    }
  }, [help]);

  // Found it (the user installed one and came back): say so and get out of
  // the way instead of leaving a stale warning.
  const wasMissing = useRef(false);
  useEffect(() => {
    if (help) {
      wasMissing.current = true;
    } else if (wasMissing.current && status?.available) {
      wasMissing.current = false;
      setOpen(false);
      notifySuccess(t("engine.found"));
    }
  }, [help, status, t]);

  if (!help || !status) return null;

  const onRecheck = async () => {
    const s = await recheck();
    if (s && !s.available) notifyInfo(t("engine.still_missing"));
  };

  const title =
    status.platform === "windows"
      ? t("engine.title_windows")
      : t("engine.title_linux");

  return (
    <>
      <button
        type="button"
        data-testid="render-engine-indicator"
        title={title}
        aria-label={title}
        onClick={() => setOpen(true)}
        className="flex items-center justify-center rounded-md [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
      >
        <StatusBadge
          status="engine_missing"
          label={t("engine.badge")}
          compact
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          data-testid="render-engine-dialog"
          className="max-h-[90vh] max-w-xl overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{t("engine.description")}</DialogDescription>
          </DialogHeader>
          {status.platform === "windows" ? (
            <WindowsSteps status={status} open={open} />
          ) : (
            <LinuxSteps status={status} />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("engine.later")}
            </Button>
            <Button
              data-testid="render-engine-recheck"
              onClick={() => void onRecheck()}
              disabled={checking}
            >
              <RefreshCw
                className={
                  checking
                    ? "mr-1.5 h-4 w-4 motion-safe:animate-spin"
                    : "mr-1.5 h-4 w-4"
                }
                aria-hidden="true"
              />
              {t("engine.recheck")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
