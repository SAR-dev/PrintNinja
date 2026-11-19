import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The small dialog both layouts open from the mismatch warning: one
 * number field, prefilled with the width the current print needs.
 */
export function PaperSizeDialog({
  open,
  onOpenChange,
  value,
  onValueChange,
  error,
  onErrorChange,
  busy,
  onSave,
  printerName,
  previewW,
  currentW,
  field,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onValueChange: (value: string) => void;
  error: string | null;
  onErrorChange: (error: string | null) => void;
  busy: boolean;
  onSave: () => void;
  printerName: string;
  previewW: number;
  currentW: number;
  field: string;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("print.paper_size_title", {
              name: printerName,
            })}
          </DialogTitle>
          <DialogDescription>
            {t("print.paper_size_hint", {
              w: previewW,
              cur: currentW,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className={field}>
          <Label htmlFor="printer-paper-width">
            {t("printers.paper_width_mm")}
          </Label>
          <Input
            id="printer-paper-width"
            type="number"
            min={1}
            max={1000}
            step={1}
            value={value}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "printer-paper-width-error" : undefined}
            onChange={(e) => {
              onValueChange(e.target.value);
              onErrorChange(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onSave();
            }}
            autoFocus
          />
          {error && (
            <p
              id="printer-paper-width-error"
              role="alert"
              data-testid="paper-width-error"
              className="text-xs text-destructive"
            >
              {t(error)}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => void onSave()}
            disabled={busy}
            data-testid="save-paper-width"
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
