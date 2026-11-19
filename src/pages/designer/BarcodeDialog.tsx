import { useTranslation } from "react-i18next";
import { useState } from "react";
import { QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { BARCODE_TYPES, buildBarcodeSnippet } from "@/lib/utils/barcode";

/**
 * The barcode helper dialog: picks the type, the fixed value (or the
 * data field read at print time) and inserts the snippet at the editor
 * cursor. Its state is dialog-local; `onInsert` is the editor's
 * insert-at-cursor action.
 */
export function BarcodeDialog({
  open,
  onOpenChange,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (text: string, back?: number) => void;
}) {
  const { t } = useTranslation();
  const [barcodeType, setBarcodeType] = useState("code128");
  const [barcodeValue, setBarcodeValue] = useState("");
  // On: the value is a data field (order.id) read at print time. Off: fixed text.
  const [barcodeFromData, setBarcodeFromData] = useState(true);
  const [barcodeError, setBarcodeError] = useState<string | null>(null);

  const handleInsertBarcode = () => {
    const snippet = buildBarcodeSnippet(
      barcodeType,
      barcodeValue,
      barcodeFromData,
    );
    if (!snippet.ok) {
      setBarcodeError(
        t(
          snippet.messageKey,
          snippet.messageParams as Record<string, string> | undefined,
        ),
      );
      return;
    }
    onInsert(snippet.text);
    onOpenChange(false);
    setBarcodeValue("");
    setBarcodeError(null);
    // The element lands on the canvas — visible, no toast.
  };

  return (
    /* Barcode Dialog */
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("designer.barcode_title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="barcode-type">{t("designer.barcode_type")}</Label>
            <Select value={barcodeType} onValueChange={setBarcodeType}>
              <SelectTrigger id="barcode-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BARCODE_TYPES.map((bc) => (
                  <SelectItem key={bc.value} value={bc.value}>
                    {bc.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="barcode-from-data" className="text-sm">
              {t("designer.barcode_from_data")}
            </Label>
            <Switch
              id="barcode-from-data"
              checked={barcodeFromData}
              onCheckedChange={(on) => {
                setBarcodeFromData(on);
                setBarcodeError(null);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="barcode-value">
              {barcodeFromData
                ? t("designer.barcode_field")
                : t("designer.barcode_value")}
            </Label>
            <Input
              id="barcode-value"
              placeholder={
                barcodeFromData
                  ? t("designer.barcode_field_example")
                  : t("designer.barcode_value_hint")
              }
              value={barcodeValue}
              onChange={(e) => {
                setBarcodeValue(e.target.value);
                setBarcodeError(null);
              }}
            />
            <p className="text-xs text-muted-foreground">
              {barcodeFromData
                ? t("designer.barcode_per_print")
                : t("designer.barcode_same")}
            </p>
            {barcodeError && (
              <p
                id="barcode-error"
                role="alert"
                className="text-xs text-danger"
              >
                {barcodeError}
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            id="barcode-insert"
            onClick={handleInsertBarcode}
            disabled={!barcodeValue}
          >
            <QrCode className="h-4 w-4" />
            {t("designer.barcode_insert")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
