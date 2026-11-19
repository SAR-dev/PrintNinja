import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { agent } from "@/lib/agent/commands";
import { describeError } from "@/lib/errors";
import { notifyError, notifySuccess } from "@/lib/notify";
import { readCachedSetting, readSetting, writeSetting } from "@/lib/settings";

/**
 * Settings → Retention: how long job history is kept, and the
 * full database reset. Values validate on blur and save on blur —
 * the typed value staying in the field is the visible result.
 */
export function RetentionSection() {
  const { t } = useTranslation();

  const [retentionDays, setRetentionDays] = useState(
    () => readCachedSetting("retention_days") ?? "30",
  );
  const [maxRecords, setMaxRecords] = useState(
    () => readCachedSetting("max_records") ?? "10000",
  );
  const [retentionError, setRetentionError] = useState("");
  const [maxError, setMaxError] = useState("");
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  // The cache paints the first frame; the DB read corrects it if the
  // two ever diverge.
  useEffect(() => {
    (async () => {
      const [days, max] = await Promise.all([
        readSetting("retention_days"),
        readSetting("max_records"),
      ]);
      if (days) setRetentionDays(days);
      if (max) setMaxRecords(max);
    })();
  }, []);

  // Same behaviour for every numeric setting: validate, then save. The
  // typed value stays in the field — the save is visible, so no toast.
  const saveNumber = async (
    key: string,
    value: string,
    min: number,
    label: string,
    setErr: (m: string) => void,
  ) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) {
      setErr(t("settings_page.number_error", { label, min }));
      return;
    }
    setErr("");
    await writeSetting(key, String(n));
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("settings_page.retention")}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="retention-days">
              {t("settings_page.retention_days")}
            </Label>
            <Input
              id="retention-days"
              type="number"
              min="1"
              value={retentionDays}
              aria-invalid={!!retentionError}
              aria-describedby={
                retentionError ? "retention-days-error" : undefined
              }
              onChange={(e) => {
                setRetentionDays(e.target.value);
                setRetentionError("");
              }}
              onBlur={() =>
                saveNumber(
                  "retention_days",
                  retentionDays,
                  1,
                  t("settings_page.retention_days"),
                  setRetentionError,
                )
              }
            />
            {retentionError && (
              <p
                id="retention-days-error"
                role="alert"
                className="text-xs text-danger"
              >
                {retentionError}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="max-records">
              {t("settings_page.max_records")}
            </Label>
            <Input
              id="max-records"
              type="number"
              min="100"
              value={maxRecords}
              aria-invalid={!!maxError}
              aria-describedby={maxError ? "max-records-error" : undefined}
              onChange={(e) => {
                setMaxRecords(e.target.value);
                setMaxError("");
              }}
              onBlur={() =>
                saveNumber(
                  "max_records",
                  maxRecords,
                  100,
                  t("settings_page.max_records"),
                  setMaxError,
                )
              }
            />
            {maxError && (
              <p
                id="max-records-error"
                role="alert"
                className="text-xs text-danger"
              >
                {maxError}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("settings_page.reset_title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t("settings_page.reset_desc")}
          </p>
          <Button
            variant="destructive"
            id="settings-reset-database"
            data-testid="settings-reset-database"
            onClick={() => setShowResetDialog(true)}
          >
            <Trash2 className="h-3 w-3 mr-2" />
            {t("settings_page.reset_action")}
          </Button>
        </CardContent>
      </Card>

      {/* Full-reset confirmation: the wipe cannot be undone. */}
      <Dialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings_page.reset_confirm_title")}</DialogTitle>
            <DialogDescription>
              {t("settings_page.reset_body")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowResetDialog(false)}
              disabled={resetBusy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={resetBusy}
              onClick={() => {
                void (async () => {
                  setResetBusy(true);
                  try {
                    const report = await agent("reset_database", {});
                    notifySuccess(
                      t("settings_page.toast_reset_done", {
                        templates: report.templates,
                        jobs: report.print_jobs,
                        fonts: report.fonts,
                      }),
                    );
                    window.location.reload();
                  } catch (e) {
                    notifyError(
                      t("settings_page.toast_reset_failed", {
                        error: describeError(e),
                      }),
                    );
                  } finally {
                    setResetBusy(false);
                    setShowResetDialog(false);
                  }
                })();
              }}
            >
              {resetBusy
                ? t("settings_page.reset_erasing")
                : t("settings_page.reset_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
