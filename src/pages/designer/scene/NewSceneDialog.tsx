/**
 * The "new label template" dialog: name the scene and create it as its
 * own local row — scene rows are not shared, so there is no pack step
 * and no offline gate. When the open template is a scene, the same
 * dialog also offers deleting it (one extra confirm in the footer).
 */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
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
import type { TemplateRow } from "../useDesignerDocument";
import type { useSceneTemplate } from "./useSceneTemplate";

/**
 * The "new label template" dialog state and the create round-trip.
 * Creation goes straight to the local row (no server); deletion removes
 * the open scene row and resets the open template.
 */
export function useNewSceneTemplate(deps: {
  templates: TemplateRow[];
  setTemplates: (fn: (prev: TemplateRow[]) => TemplateRow[]) => void;
  setCurrentTemplateId: (id: number | null) => void;
  setCurrentTemplateDbId: (id: number | null) => void;
  currentTemplateId: number | null;
  currentTemplateDbId: number | null;
  scene: ReturnType<typeof useSceneTemplate>;
}) {
  const { t } = useTranslation();
  const [showDialog, setShowDialog] = useState(false);
  const [name, setName] = useState("");
  // Name problems show under the field, not as a toast.
  const [nameError, setNameError] = useState("");
  // The create round-trip is async: while it runs the dialog holds
  // still so a second click cannot double-create.
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const openDialog = useCallback(() => {
    setName("");
    setNameError("");
    setConfirmDelete(false);
    setShowDialog(true);
  }, []);
  const handleOpenChange = (open: boolean) => {
    setShowDialog(open);
    if (!open) {
      setName("");
      setNameError("");
      setConfirmDelete(false);
    }
  };

  // The scene row the delete button acts on — only when the open
  // template is a scene.
  const openScene =
    deps.templates.find(
      (r) => r.id === deps.currentTemplateId && r.track === "scene",
    ) ?? null;

  const create = async () => {
    const n = name.trim();
    if (!n) {
      setNameError(t("designer.toast_name_required"));
      return;
    }
    if (deps.templates.some((r) => r.name.toLowerCase() === n.toLowerCase())) {
      setNameError(t("designer.toast_name_exists"));
      return;
    }
    setNameError("");
    setCreating(true);
    try {
      const ok = await deps.scene.create(n);
      if (ok) setShowDialog(false);
    } finally {
      setCreating(false);
    }
  };

  const remove = async () => {
    if (!openScene) return;
    setDeleting(true);
    try {
      await agent("delete_template", { id: openScene.id });
      deps.setTemplates((prev) => prev.filter((r) => r.id !== openScene.id));
      if (deps.currentTemplateId === openScene.id) {
        deps.setCurrentTemplateId(null);
        deps.setCurrentTemplateDbId(null);
      }
      notifySuccess(t("scene.deleted", { name: openScene.name }));
      setShowDialog(false);
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setDeleting(false);
    }
  };

  return {
    showDialog,
    openDialog,
    handleOpenChange,
    name,
    setName,
    nameError,
    setNameError,
    creating,
    create,
    confirmDelete,
    setConfirmDelete,
    deleting,
    remove,
    openScene,
  };
}

export function NewSceneDialog({
  newScene,
}: {
  newScene: ReturnType<typeof useNewSceneTemplate>;
}) {
  const { t } = useTranslation();
  const s = newScene;
  return (
    <Dialog open={s.showDialog} onOpenChange={s.handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("scene.new_title")}</DialogTitle>
          <DialogDescription>{t("scene.new_description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="new-scene-name">{t("common.name")}</Label>
          <Input
            id="new-scene-name"
            placeholder={t("scene.new_name_example")}
            value={s.name}
            onChange={(e) => {
              s.setName(e.target.value);
              s.setNameError("");
            }}
            aria-describedby={s.nameError ? "new-scene-name-error" : undefined}
            disabled={s.creating}
            autoFocus
          />
          {s.nameError && (
            <p
              id="new-scene-name-error"
              role="alert"
              className="text-xs text-danger"
            >
              {s.nameError}
            </p>
          )}
          {s.confirmDelete && s.openScene && (
            <p role="alert" className="pt-2 text-body-sm text-danger">
              {t("scene.delete_confirm_note", { name: s.openScene.name })}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => s.handleOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          {s.openScene &&
            (s.confirmDelete ? (
              <Button
                variant="destructive"
                onClick={() => void s.remove()}
                disabled={s.deleting}
                data-testid="scene-delete-confirm"
              >
                {s.deleting ? t("scene.deleting") : t("scene.delete_confirm")}
              </Button>
            ) : (
              <Button
                variant="outline"
                className="text-destructive"
                onClick={() => s.setConfirmDelete(true)}
                data-testid="scene-delete"
              >
                {t("scene.delete")}
              </Button>
            ))}
          <Button
            onClick={() => void s.create()}
            disabled={s.creating}
            data-testid="scene-create"
          >
            {s.creating ? t("scene.creating") : t("scene.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
