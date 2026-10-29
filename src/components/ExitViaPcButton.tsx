import { useState } from "react";
import { useTranslation } from "react-i18next";
import { notifySuccess, notifyError } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/errors";
import { setPrintViaPc } from "@/lib/printViaPc";

/**
 * One-tap exit from Print-via-PC mode, for phones stuck printing
 * through an unreachable PC. Flips the flag off; the caller refreshes
 * its own state (banner, lists) through `onExited`.
 */
export function ExitViaPcButton({ onExited }: { onExited?: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const exit = async () => {
    setBusy(true);
    try {
      await setPrintViaPc(false);
      onExited?.();
      notifySuccess(t("print.via_pc_exited"));
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      data-testid="via-pc-exit"
      disabled={busy}
      onClick={() => void exit()}
    >
      {t("print.via_pc_exit")}
    </Button>
  );
}
