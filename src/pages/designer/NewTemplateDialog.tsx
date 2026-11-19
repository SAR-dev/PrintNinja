import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PackChooser } from "@/components/designer/PackChooser";

/**
 * The two-step "new template" chooser: pick the pack first, then name
 * the template. The state lives in `useNewTemplate`; this dialog only
 * renders it.
 */
export function NewTemplateDialog({
  open,
  onOpenChange,
  step,
  setStep,
  packId,
  setPackId,
  name,
  setName,
  nameError,
  setNameError,
  creating,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  step: "pack" | "name";
  setStep: (step: "pack" | "name") => void;
  packId: string;
  setPackId: (id: string) => void;
  name: string;
  setName: (name: string) => void;
  nameError: string;
  setNameError: (error: string) => void;
  creating: boolean;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  return (
    /* New Template Dialog — two-step chooser */
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>{t("designer.new_chooser_title")}</DialogTitle>
          <DialogDescription>
            {t("designer.new_chooser_hint")}
          </DialogDescription>
        </DialogHeader>
        {step === "pack" ? (
          <>
            <div className="space-y-3">
              <p className="text-sm font-medium">
                {t("designer.new_step_pack")}
              </p>
              <PackChooser selectedId={packId} onSelect={setPackId} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                onClick={() => {
                  if (!name.trim()) {
                    const key = `designer.pack_${packId}_name` as const;
                    const hint = t(key, { defaultValue: "" });
                    if (hint) setName(hint);
                  }
                  setStep("name");
                }}
                data-testid="pack-next"
              >
                {t("designer.new_next")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-3">
              <p className="text-sm font-medium">
                {t("designer.new_step_name")}
              </p>
              <div className="space-y-1">
                <Label htmlFor="new-template-name">
                  {t("designer.template_name")}
                </Label>
                <Input
                  id="new-template-name"
                  placeholder={t("designer.new_name_example")}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameError("");
                  }}
                  aria-describedby={
                    nameError ? "new-template-name-error" : undefined
                  }
                  disabled={creating}
                  autoFocus
                />
                {nameError && (
                  <p
                    id="new-template-name-error"
                    role="alert"
                    className="text-xs text-danger"
                  >
                    {nameError}
                  </p>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setStep("pack")}
                disabled={creating}
              >
                {t("designer.new_back")}
              </Button>
              <Button
                onClick={onCreate}
                disabled={creating}
                data-testid="pack-create"
              >
                {creating
                  ? t("designer.new_creating")
                  : t("designer.new_create")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
