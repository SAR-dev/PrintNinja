import { Plus, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { LayoutToggle, type DesignerLayout } from "./LayoutToggle";
import { TemplateSwitcher } from "./TemplateSwitcher";

interface Props {
  /** The templates to switch between. Without them the switcher is not drawn. */
  templates?: Array<{ id: number; name: string; origin?: string | null }>;
  currentTemplateId?: number | null;
  onSelectTemplate?: (id: number) => void;
  /** No template is open yet: only New is offered. */
  noTemplate?: boolean;
  /** Why the name cannot be saved, shown under the field. */
  nameError?: string;
  /** The editor holds changes that Save has not sent yet. */
  dirty?: boolean;
  /** Desktop workspace layout, switched from this row. */
  layout?: DesignerLayout;
  onLayoutChange?: (layout: DesignerLayout) => void;
  onNew: () => void;
  onSave: () => void;
  /** Offline: the server owns the copies, so there is nowhere to save. */
  saveDisabled?: boolean;
  saveTitle?: string;
  /** The open template's name, edited in place; the rename lands on the
   * next Save through the existing flow. Mobile keeps the Page Setup
   * field instead — this is the desktop shortcut. */
  templateName: string;
  onTemplateNameChange: (name: string) => void;
  remoteId: string | null;
  publishedAt: string | null;
  /** Saved (community) copies are read-only: save and visibility are hidden. */
  readOnly?: boolean;
  /** The action running right now, so controls disable while it runs. */
  pending: "save" | "visibility" | null;
  onVisibilityChange: (makePublic: boolean) => void;
}

/** The Designer's top row: switch template, rename it (the one place a
 * template is renamed), New, Save and visibility. Save is the one manual
 * push to the server; offline it is disabled because viewing and printing
 * are all the cache can do. Visibility is publish/unpublish applied
 * immediately via the switch, whose Public/Private label already
 * describes the state. */
export function DesignerToolbar({
  templates,
  currentTemplateId = null,
  onSelectTemplate,
  noTemplate = false,
  nameError,
  dirty = false,
  layout,
  onLayoutChange,
  onNew,
  onSave,
  saveDisabled = false,
  saveTitle,
  templateName,
  onTemplateNameChange,
  remoteId,
  publishedAt,
  readOnly = false,
  pending,
  onVisibilityChange,
}: Props) {
  const { t } = useTranslation();
  const busy = pending != null;
  const published = !!remoteId && !!publishedAt;
  const errorId = "designer-template-name-error";
  return (
    <div className="flex flex-wrap items-start gap-2">
      {templates && onSelectTemplate && !noTemplate && (
        <TemplateSwitcher
          templates={templates}
          currentTemplateId={currentTemplateId}
          disabled={busy}
          onSelect={(tpl) => onSelectTemplate(tpl.id)}
        />
      )}
      {!noTemplate && (
        <div className="min-w-[14rem] flex-1">
          <div className="flex items-center gap-2">
            {/* A saved copy still shows its name, in the same field, disabled. */}
            <Input
              value={templateName}
              onChange={(e) => onTemplateNameChange(e.target.value)}
              disabled={busy || readOnly}
              aria-label={t("designer.template_name")}
              aria-invalid={!readOnly && nameError ? true : undefined}
              aria-describedby={!readOnly && nameError ? errorId : undefined}
              className="h-8 min-w-0 flex-1 font-medium"
            />
            {readOnly && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {t("designer.read_only")}
              </span>
            )}
          </div>
          {!readOnly && nameError && (
            <p id={errorId} role="alert" className="mt-1 text-xs text-danger">
              {nameError}
            </p>
          )}
        </div>
      )}
      {noTemplate && <div className="flex-1" />}
      {dirty && !readOnly && !noTemplate && (
        <span className="flex h-8 items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className="h-2 w-2 rounded-full bg-warning"
            aria-hidden="true"
          />
          {t("designer.unsaved")}
        </span>
      )}
      {layout && onLayoutChange && (
        <LayoutToggle value={layout} onChange={onLayoutChange} />
      )}
      <Button variant="outline" size="sm" onClick={onNew}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        {t("designer.newTemplate")}
      </Button>
      {!noTemplate && !readOnly && (
        <Button
          size="sm"
          onClick={onSave}
          disabled={saveDisabled || busy}
          title={saveTitle}
          data-testid="designer-save"
        >
          <Save className="h-4 w-4" aria-hidden="true" />
          {t("common.save")}
        </Button>
      )}
      {!noTemplate &&
        !readOnly &&
        (!remoteId ? (
          <span className="flex h-8 items-center text-xs text-muted-foreground">
            {t("designer.only_local")}
          </span>
        ) : (
          <div className="flex h-8 items-center gap-2">
            <Label htmlFor="template-visibility" className="text-xs">
              {published
                ? t("designer.visibility_public")
                : t("designer.visibility_private")}
            </Label>
            <Switch
              id="template-visibility"
              data-testid="template-visibility"
              checked={published}
              disabled={busy}
              onCheckedChange={(v) => onVisibilityChange(v)}
              aria-label={t("designer.visibility_toggle", {
                state: published
                  ? t("designer.visibility_public")
                  : t("designer.visibility_private"),
              })}
            />
            <span
              className="font-mono text-xs text-muted-foreground"
              title={remoteId}
              data-testid="designer-sync-id"
            >
              {remoteId.slice(0, 8)}
            </span>
          </div>
        ))}
    </div>
  );
}
