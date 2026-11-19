import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SyncAction } from "./useTemplateSync";

/**
 * Save conflict: the server copy moved since this PC last synced it.
 * Two ways out, both explicit — nothing is chosen for the user, and
 * nothing is queued to resolve later.
 */
export function SaveConflictDialog({
  open,
  onOpenChange,
  pending,
  onOverwrite,
  onTakeServer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: SyncAction | null;
  onOverwrite: () => void;
  onTakeServer: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="save-conflict-dialog">
        <DialogHeader>
          <DialogTitle>{t("designer.conflict_title")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t("designer.conflict_body")}
        </p>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            data-testid="save-conflict-overwrite"
            onClick={onOverwrite}
            disabled={pending !== null}
          >
            {pending === "save"
              ? t("designer.conflict_overwriting")
              : t("designer.conflict_overwrite")}
          </Button>
          <Button
            data-testid="save-conflict-take-server"
            variant="outline"
            onClick={onTakeServer}
            disabled={pending !== null}
          >
            {pending === "save"
              ? t("designer.conflict_loading")
              : t("designer.conflict_take_server")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
