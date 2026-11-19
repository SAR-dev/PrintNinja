import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Trash2, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { agent } from "@/lib/agent/commands";
import type {
  BrowserShellStatus,
  FixReport,
  RenderEngineStatus,
} from "@/lib/agent/types";
import { describeError } from "@/lib/errors";
import { notifyError, notifySuccess } from "@/lib/notify";

/**
 * Settings → Diagnostics → Windows print-pipeline repair. `engine`
 * doubles as the platform check: the repair only exists where the
 * Edge handoff failure can (Windows). Owns the confirm dialog, the
 * report, and the opt-in headless shell (the repair's fallback) —
 * its status, download progress and removal. Nothing is downloaded
 * without an explicit press.
 */
export function PrintRepairCard({
  engine,
}: {
  engine: RenderEngineStatus | null;
}) {
  const { t } = useTranslation();
  const isWindows = engine?.platform === "windows";

  const [fixOpen, setFixOpen] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixReport, setFixReport] = useState<FixReport | null>(null);
  const runFix = useCallback(async () => {
    setFixing(true);
    setFixReport(null);
    try {
      const report = await agent("fix_pc_print", { close_edge: true });
      setFixReport(report);
      if (report?.test_render_ok) {
        notifySuccess(t("settings_page.toast_fix_ok"));
      } else {
        notifyError(t("settings_page.toast_fix_failed"));
      }
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setFixing(false);
    }
  }, [t]);

  const [shellStatus, setShellStatus] = useState<BrowserShellStatus | null>(
    null,
  );
  const [shellBusy, setShellBusy] = useState(false);
  const [shellProgress, setShellProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const refreshShellStatus = useCallback(async () => {
    try {
      const status = await agent("browser_shell_status", {});
      setShellStatus(status ?? null);
    } catch {
      setShellStatus(null);
    }
  }, []);
  useEffect(() => {
    if (fixReport && isWindows) void refreshShellStatus();
  }, [fixReport, isWindows, refreshShellStatus]);
  const downloadShell = useCallback(async () => {
    setShellBusy(true);
    setShellProgress(null);
    let unlisten: (() => void) | null = null;
    try {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<{ done: number; total: number }>(
          "browser-shell-progress",
          (e) => setShellProgress(e.payload),
        );
      } catch {
        /* no Tauri event bridge (web preview / tests): no live progress */
      }
      await agent("browser_shell_download", {});
      notifySuccess(t("settings_page.diag_fix_shell_ready"));
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      unlisten?.();
      setShellBusy(false);
      setShellProgress(null);
      await refreshShellStatus();
    }
  }, [refreshShellStatus, t]);
  const removeShell = useCallback(async () => {
    setShellBusy(true);
    try {
      await agent("browser_shell_remove", {});
      await refreshShellStatus();
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setShellBusy(false);
    }
  }, [refreshShellStatus]);
  const cancelShell = useCallback(async () => {
    try {
      await agent("browser_shell_cancel", {});
    } catch (e) {
      notifyError(describeError(e));
    }
    // The in-flight download notices the flag on its next chunk and bails;
    // `downloadShell`'s finally then refreshes the status.
    void refreshShellStatus();
  }, [refreshShellStatus]);

  return (
    <>
      {isWindows && (
        <>
          <p className="text-sm text-muted-foreground">
            {t("settings_page.diag_fix_pc_print_hint")}
          </p>
          <Button
            variant="outline"
            id="settings-diag-fix-pc-print"
            disabled={fixing}
            onClick={() => setFixOpen(true)}
          >
            <Wrench className="h-4 w-4 mr-2" />
            {fixing
              ? t("settings_page.diag_fix_pc_print_running")
              : t("settings_page.diag_fix_pc_print")}
          </Button>
        </>
      )}
      {fixReport && (
        <div
          id="settings-diag-fix-result"
          className="rounded-md border p-3 text-sm"
        >
          <ul className="space-y-1">
            <li>
              {fixReport.edge_found
                ? t("settings_page.fix_edge_found")
                : t("settings_page.fix_edge_missing")}
            </li>
            {fixReport.edge_was_running && (
              <li>
                {fixReport.edge_closed
                  ? t("settings_page.fix_edge_closed")
                  : t("settings_page.fix_edge_running")}
              </li>
            )}
            {fixReport.edge_closed && !fixReport.edge_verified_dead && (
              <li
                id="settings-diag-fix-edge-survived"
                className="text-destructive"
              >
                {t("settings_page.diag_fix_edge_still_running")}
              </li>
            )}
            {fixReport.elevated && (
              <li id="settings-diag-fix-elevated" className="text-destructive">
                {t("settings_page.fix_elevated")}
              </li>
            )}
            <li>
              {fixReport.profiles_removed.length > 0
                ? t("settings_page.fix_profiles_removed", {
                    n: fixReport.profiles_removed.length,
                  })
                : t("settings_page.fix_no_profiles")}
            </li>
            {fixReport.cooldown_reset && (
              <li>{t("settings_page.fix_cooldown")}</li>
            )}
            <li
              className={
                fixReport.test_render_ok ? "text-success" : "text-destructive"
              }
            >
              {fixReport.test_render_ok
                ? t("settings_page.fix_test_ok")
                : t("settings_page.fix_test_failed")}
            </li>
          </ul>
          {fixReport.test_render_error && (
            <p className="mt-2 break-words text-xs text-muted-foreground">
              {describeError(fixReport.test_render_error)}
            </p>
          )}
          {!fixReport.test_render_ok && (
            <div id="settings-diag-shell-offer" className="mt-3 border-t pt-3">
              <p className="text-xs text-muted-foreground">
                {t("settings_page.diag_fix_shell_offer")}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {shellStatus?.state === "ready" ? (
                  <>
                    <p
                      id="settings-diag-shell-ready"
                      className="text-xs text-success"
                    >
                      {t("settings_page.diag_fix_shell_ready")}
                    </p>
                    <Button
                      variant="outline"
                      id="settings-diag-shell-remove"
                      disabled={shellBusy}
                      onClick={() => void removeShell()}
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      {t("settings_page.diag_fix_shell_remove")}
                    </Button>
                  </>
                ) : shellBusy ? (
                  <div className="flex items-center gap-2">
                    <p id="settings-diag-shell-downloading" className="text-xs">
                      {t("settings_page.diag_fix_shell_downloading", {
                        done: shellProgress
                          ? Math.floor(shellProgress.done / 1048576)
                          : 0,
                        total: shellProgress
                          ? Math.max(
                              1,
                              Math.floor(shellProgress.total / 1048576),
                            )
                          : 0,
                      })}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      id="settings-diag-shell-cancel"
                      onClick={() => void cancelShell()}
                    >
                      {t("settings_page.diag_shell_cancel")}
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    id="settings-diag-shell-download"
                    onClick={() => void downloadShell()}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    {t("settings_page.diag_fix_shell_download")}
                  </Button>
                )}
              </div>
              {shellStatus?.state === "error" && shellStatus.error && (
                <p
                  id="settings-diag-shell-error"
                  className="mt-2 break-words text-xs text-destructive"
                >
                  {describeError(new Error(shellStatus.error))}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Print repair confirmation: it closes Edge windows without saving. */}
      <Dialog open={fixOpen} onOpenChange={(o) => !fixing && setFixOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings_page.fix_title")}</DialogTitle>
            <DialogDescription>{t("settings_page.fix_hint")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setFixOpen(false)}
              disabled={fixing}
            >
              {t("settings_page.fix_cancel")}
            </Button>
            <Button
              disabled={fixing}
              onClick={() => {
                setFixOpen(false);
                void runFix();
              }}
            >
              {t("settings_page.fix_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
