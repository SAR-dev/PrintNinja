import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/PageHeader";
import { DesignerToolbar } from "@/components/designer/DesignerToolbar";
import { DesignerOverflowMenu } from "@/components/designer/DesignerOverflowMenu";
import type { DesignerLayout } from "@/components/designer/LayoutToggle";
import type { TemplateRow } from "./useDesignerDocument";
import type { SyncAction } from "./useTemplateSync";

/**
 * The page's top row: on desktop the toolbar that names, switches and
 * saves the open template (the sidebar already says which page this is,
 * so the title stays for screen readers only); on a phone the page
 * header naming the open template; on a tablet the header plus the
 * overflow menu whose editing actions do not exist on a phone.
 */
export function DesignerTopBar({
  isDesktop,
  isPhone,
  templates,
  currentTemplateId,
  noTemplate,
  onSwitchTemplate,
  nameError,
  dirty,
  layout,
  onLayoutChange,
  onNewDesktop,
  onNewTablet,
  onSave,
  offline,
  readOnly,
  templateName,
  onTemplateNameChange,
  remoteId,
  publishedAt,
  pending,
  onVisibilityChange,
  onHistory,
}: {
  isDesktop: boolean;
  isPhone: boolean;
  templates: TemplateRow[];
  currentTemplateId: number | null;
  noTemplate: boolean;
  onSwitchTemplate: (id: number) => void;
  nameError: string;
  dirty: boolean;
  layout: DesignerLayout;
  onLayoutChange: (layout: DesignerLayout) => void;
  /** Desktop toolbar New: asks first when edits are unsaved. */
  onNewDesktop: () => void;
  /** Tablet overflow menu New: opens the dialog directly. */
  onNewTablet: () => void;
  onSave: () => void;
  offline: boolean;
  readOnly: boolean;
  templateName: string;
  onTemplateNameChange: (name: string) => void;
  remoteId: string | null;
  publishedAt: string | null;
  pending: SyncAction | null;
  onVisibilityChange: (v: boolean) => void;
  onHistory: () => void;
}) {
  const { t } = useTranslation();
  return isDesktop ? (
    // The top row replaces the page header: it names, switches and saves
    // the open template. The sidebar already says which page this is, so
    // the title stays for screen readers only.
    <div data-slot="page-header" className="border-b pb-4">
      <h1 className="sr-only">{t("designer.title")}</h1>
      <DesignerToolbar
        templates={templates}
        currentTemplateId={currentTemplateId}
        onSelectTemplate={onSwitchTemplate}
        noTemplate={noTemplate}
        nameError={nameError}
        dirty={dirty}
        layout={layout}
        onLayoutChange={onLayoutChange}
        onNew={onNewDesktop}
        onSave={onSave}
        saveDisabled={offline || readOnly || !!nameError}
        saveTitle={offline ? t("designer.save_offline_title") : undefined}
        templateName={templateName}
        onTemplateNameChange={onTemplateNameChange}
        remoteId={remoteId}
        publishedAt={publishedAt}
        readOnly={readOnly}
        pending={pending}
        onVisibilityChange={(v) => void onVisibilityChange(v)}
        onHistory={onHistory}
      />
    </div>
  ) : isPhone ? (
    // The viewer shows the open template: the header names it, and the
    // overflow menu's editing actions do not exist on a phone.
    <PageHeader
      title={templateName || t("designer.title")}
      description={t("pages.designer")}
    />
  ) : (
    <PageHeader title={t("designer.title")} description={t("pages.designer")}>
      <DesignerOverflowMenu
        onNew={onNewTablet}
        published={!!remoteId && !!publishedAt}
        remoteId={remoteId}
        readOnly={readOnly}
        busy={pending != null}
        dirty={dirty}
        onVisibilityChange={(v) => void onVisibilityChange(v)}
        onHistory={onHistory}
      />
    </PageHeader>
  );
}
