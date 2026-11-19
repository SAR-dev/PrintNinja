import { useTranslation } from "react-i18next";
import { describeError } from "@/lib/errors";
import { notifyError } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";

/**
 * The editor for the account's single sample dataset (JSON). The draft
 * text and open state live in `useSampleDataset`; `onSave` writes the
 * draft to the dataset's working state.
 */
export function EditDatasetDialog({
  open,
  onOpenChange,
  editJson,
  setEditJson,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editJson: string;
  setEditJson: (value: string) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  return (
    /* Edit the account's single sample dataset (JSON) */
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("designer.sample_edit")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>{t("designer.sample_json_label")}</Label>
            <div className="rounded-md border overflow-hidden">
              <CodeMirror
                value={editJson}
                height="200px"
                extensions={[json()]}
                onChange={setEditJson}
                theme="light"
                basicSetup={{ lintKeymap: true }}
              />
            </div>
            {(() => {
              try {
                JSON.parse(editJson);
                return null;
              } catch (e) {
                return (
                  <p className="text-xs text-danger">
                    {describeError(e).split("\n")[0]}
                  </p>
                );
              }
            })()}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              try {
                JSON.parse(editJson);
              } catch {
                notifyError(t("designer.toast_invalid_json"));
                return;
              }
              onSave();
              onOpenChange(false);
              // The panel re-renders with the saved rows — visible.
            }}
          >
            {t("designer.sample_save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
