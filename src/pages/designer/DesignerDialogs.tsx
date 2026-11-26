import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { BarcodeDialog } from "./BarcodeDialog";
import { EditDatasetDialog } from "./EditDatasetDialog";
import { NewTemplateDialog } from "./NewTemplateDialog";
import { SaveConflictDialog } from "./SaveConflictDialog";
import { VersionHistory } from "./VersionHistory";
import { NewSceneDialog } from "./scene/NewSceneDialog";
import type { useDesignerDocument } from "./useDesignerDocument";
import type { useTemplateSync } from "./useTemplateSync";
import type { useSampleDataset } from "./useSampleDataset";
import type { useNewTemplate } from "./useNewTemplate";
import type { useNewSceneTemplate } from "./scene/NewSceneDialog";

/**
 * The page's dialogs: barcode insertion, the sample-dataset editor,
 * new-template creation (document and scene), the discard
 * confirmation, save-conflict resolution and the version history.
 */
export function DesignerDialogs({
  barcodeOpen,
  setBarcodeOpen,
  doc,
  sync,
  dataset,
  newTemplate,
  newScene,
  insertHelper,
  offline,
  readOnly,
}: {
  barcodeOpen: boolean;
  setBarcodeOpen: (open: boolean) => void;
  doc: ReturnType<typeof useDesignerDocument>;
  sync: ReturnType<typeof useTemplateSync>;
  dataset: ReturnType<typeof useSampleDataset>;
  newTemplate: ReturnType<typeof useNewTemplate>;
  newScene: ReturnType<typeof useNewSceneTemplate>;
  insertHelper: (text: string, back?: number) => void;
  offline: boolean;
  readOnly: boolean;
}) {
  const { t } = useTranslation();

  return (
    <>
      <BarcodeDialog
        open={barcodeOpen}
        onOpenChange={setBarcodeOpen}
        onInsert={insertHelper}
      />

      <EditDatasetDialog
        open={dataset.showEditDataset}
        onOpenChange={dataset.setShowEditDataset}
        editJson={dataset.editJson}
        setEditJson={dataset.setEditJson}
        onSave={() => dataset.setDraftDatasetJson(dataset.editJson)}
      />

      <NewTemplateDialog
        open={newTemplate.showNewTemplateDialog}
        onOpenChange={newTemplate.handleNewTemplateDialogOpenChange}
        step={newTemplate.newTemplateStep}
        setStep={newTemplate.setNewTemplateStep}
        packId={newTemplate.newTemplatePackId}
        setPackId={newTemplate.setNewTemplatePackId}
        name={newTemplate.newTemplateName}
        setName={newTemplate.setNewTemplateName}
        nameError={newTemplate.newNameError}
        setNameError={newTemplate.setNewNameError}
        creating={newTemplate.creatingTemplate}
        onCreate={() => void newTemplate.createNewTemplate()}
      />

      <NewSceneDialog newScene={newScene} />

      <ConfirmDialog
        open={doc.discardAction !== null}
        onOpenChange={(open) => {
          if (!open) doc.setDiscardAction(null);
        }}
        title={t("designer.discard_title")}
        description={t("designer.discard_body")}
        confirmLabel={t("designer.discard_confirm")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={() => {
          const action = doc.discardAction;
          doc.setDiscardAction(null);
          dataset.setDraftDatasetJson(null);
          action?.();
        }}
      />

      <SaveConflictDialog
        open={sync.conflict !== null}
        onOpenChange={(open) => {
          if (!open) sync.setConflict(null);
        }}
        pending={sync.pending}
        onOverwrite={() => void sync.resolveOverwrite()}
        onTakeServer={() => void sync.resolveTakeServer()}
      />

      <VersionHistory
        open={sync.historyOpen}
        onOpenChange={sync.setHistoryOpen}
        remoteId={doc.remoteId}
        refreshKey={sync.historyRefresh}
        disabled={sync.pending != null || offline || readOnly}
        onRestore={(n) => sync.setRestorePending(n)}
        restorePending={sync.restorePending}
        onRestoreOpenChange={(open) => {
          if (!open) sync.setRestorePending(null);
        }}
        dirty={doc.dirty}
        busy={sync.pending === "save"}
        onConfirmRestore={() => {
          const n = sync.restorePending;
          if (n != null) void sync.handleRestoreVersion(n);
        }}
      />
    </>
  );
}
