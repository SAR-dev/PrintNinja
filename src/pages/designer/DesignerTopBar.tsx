import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/PageHeader";
import { DesignerToolbar } from "@/components/designer/DesignerToolbar";
import { DesignerOverflowMenu } from "@/components/designer/DesignerOverflowMenu";
import { TemplateSwitcher } from "@/components/designer/TemplateSwitcher";
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
  onSave,
  saveDisabled,
  saveTitle,
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
  /** The scene track has no document workspace, so no layout toggle. */
  layout?: DesignerLayout;
  onLayoutChange?: (layout: DesignerLayout) => void;
  onSave: () => void;
  /** Computed on the page: offline/readOnly for the document track, an
   * invalid name for the scene track (local-only, no server). */
  saveDisabled: boolean;
  saveTitle?: string;
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
        onSave={onSave}
        saveDisabled={saveDisabled}
        saveTitle={saveTitle}
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
      {/* The tablet header is the only place to switch templates on this
          size, so the switcher lives here for both tracks (the scene body
          has no templates tab of its own; the document body's tab is
          desktop-only). */}
      <TemplateSwitcher
        templates={templates}
        currentTemplateId={currentTemplateId}
        onSelect={(tpl) => onSwitchTemplate(tpl.id)}
      />
      <DesignerOverflowMenu
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
