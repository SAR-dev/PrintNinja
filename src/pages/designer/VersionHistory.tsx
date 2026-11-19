import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { VersionHistoryPanel } from "@/components/designer/VersionHistoryPanel";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";

/**
 * Version history: the server's list for the open template, with a
 * Restore per row. It stays open after a restore so the new version
 * (created by the restore itself) is visible at the top. The restore
 * asks once: it replaces the editor's content with the chosen
 * version's copy, and says so up front when edits are unsaved.
 */
export function VersionHistory({
  open,
  onOpenChange,
  remoteId,
  refreshKey,
  disabled,
  onRestore,
  restorePending,
  onRestoreOpenChange,
  dirty,
  busy,
  onConfirmRestore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remoteId: string | null;
  refreshKey: number;
  disabled: boolean;
  onRestore: (n: number) => void;
  restorePending: number | null;
  onRestoreOpenChange: (open: boolean) => void;
  dirty: boolean;
  busy: boolean;
  onConfirmRestore: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
        >
          <DialogHeader className="border-b p-5">
            <DialogTitle>{t("designer.history_title")}</DialogTitle>
            <DialogDescription>
              {t("designer.history_description")}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {remoteId ? (
              <VersionHistoryPanel
                remoteId={remoteId}
                refreshKey={refreshKey}
                disabled={disabled}
                onRestore={onRestore}
              />
            ) : (
              <p className="p-4 text-sm text-muted-foreground">
                {t("designer.history_only_local")}
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={restorePending !== null}
        onOpenChange={onRestoreOpenChange}
        title={
          restorePending != null
            ? t("designer.history_confirm_title", { n: restorePending })
            : ""
        }
        description={
          t("designer.history_confirm_body") +
          (dirty ? t("designer.history_confirm_dirty") : "")
        }
        confirmLabel={t("designer.history_restore")}
        cancelLabel={t("common.cancel")}
        destructive
        busy={busy}
        onConfirm={onConfirmRestore}
      />
    </>
  );
}
