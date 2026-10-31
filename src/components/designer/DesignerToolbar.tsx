import { Plus, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { cn } from "@/lib/utils";
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
  /** Saved (community) copies are read-only: save and visibility stay in
   * place but disabled, each with the reason on hover. */
  readOnly?: boolean;
  /** The action running right now, so controls disable while it runs. */
  pending: "save" | "visibility" | null;
  onVisibilityChange: (makePublic: boolean) => void;
}

/** A thin vertical rule between toolbar groups. */
function Divider() {
  return <span className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />;
}

/** The Designer's top row, in three groups: which template (switch + rename),
 * how the workspace looks (layout), and what happens to it (visibility, New,
 * Save). Save is the one manual push to the server; offline it is disabled
 * because viewing and printing are all the cache can do. Visibility is
 * publish/unpublish applied immediately via the switch, whose Public/Private
 * label already describes the state. Every control is 32 px tall so the row
 * reads as one line. */
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
  const invalid = !readOnly && !!nameError;
  // Save is disabled for a saved copy, offline, or while the name is invalid;
  // the reason shown is the first one that applies.
  const saveBlocked = saveDisabled || readOnly;
  const saveReason = readOnly
    ? t("designer.reason_readonly")
    : saveDisabled
      ? (saveTitle ?? nameError)
      : undefined;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {/* Group 1: the template. The switcher and the name share one frame, so
          the name reads as the label of the picker beside it. */}
      {!noTemplate ? (
        <div className="min-w-[16rem] flex-1">
          <div
            data-slot="template-field"
            className={cn(
              "flex h-8 items-center rounded-md border bg-card ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
              invalid ? "border-danger" : "border-input",
            )}
          >
            {templates && onSelectTemplate && (
              <>
                <TemplateSwitcher
                  templates={templates}
                  currentTemplateId={currentTemplateId}
                  disabled={busy}
                  onSelect={(tpl) => onSelectTemplate(tpl.id)}
                  compact
                />
                <span className="h-4 w-px bg-border" aria-hidden="true" />
              </>
            )}
            {/* A saved copy still shows its name, in the same field, disabled. */}
            <Input
              value={templateName}
              title={templateName}
              onChange={(e) => onTemplateNameChange(e.target.value)}
              disabled={busy || readOnly}
              aria-label={t("designer.template_name")}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={invalid ? errorId : undefined}
              className="h-full min-w-0 flex-1 text-ellipsis border-0 bg-transparent px-2.5 font-medium shadow-none ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            {readOnly && (
              <span className="shrink-0 pr-2.5 text-xs text-muted-foreground">
                {t("designer.read_only")}
              </span>
            )}
          </div>
          {invalid && (
            <p id={errorId} role="alert" className="mt-1 text-xs text-danger">
              {nameError}
            </p>
          )}
        </div>
      ) : (
        <div className="flex-1" />
      )}
      {dirty && !readOnly && !noTemplate && (
        <span className="flex h-8 items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className="h-2 w-2 rounded-full bg-warning"
            aria-hidden="true"
          />
          {t("designer.unsaved")}
        </span>
      )}

      {/* Group 2: the workspace. */}
      {layout && onLayoutChange && (
        <LayoutToggle value={layout} onChange={onLayoutChange} />
      )}

      {/* Group 3: what happens to the template. On a saved copy the controls
          stay put, disabled, and say why on hover. */}
      {!noTemplate &&
        (readOnly ? (
          <DisabledReason
            reason={t("designer.reason_readonly_visibility")}
            data-testid="visibility-disabled-reason"
          >
            <div className="flex h-8 items-center gap-2">
              <Label
                htmlFor="template-visibility"
                className="text-xs text-muted-foreground"
              >
                {published
                  ? t("designer.visibility_public")
                  : t("designer.visibility_private")}
              </Label>
              <Switch
                id="template-visibility"
                data-testid="template-visibility"
                checked={published}
                disabled
                aria-label={t("designer.visibility_toggle", {
                  state: published
                    ? t("designer.visibility_public")
                    : t("designer.visibility_private"),
                })}
              />
            </div>
          </DisabledReason>
        ) : !remoteId ? (
          <span className="flex h-8 items-center text-xs text-muted-foreground">
            {t("designer.only_local")}
          </span>
        ) : (
          <div className="flex h-8 items-center gap-2" title={remoteId}>
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
            {/* The server id is for support and debugging, so it sits in a
                tooltip instead of taking space in the row. */}
            <span
              className="sr-only"
              title={remoteId}
              data-testid="designer-sync-id"
            >
              {remoteId.slice(0, 8)}
            </span>
          </div>
        ))}
      {!noTemplate || (layout && onLayoutChange) ? <Divider /> : null}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onNew}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("designer.newTemplate")}
        </Button>
        {!noTemplate && (
          <DisabledReason
            reason={saveReason}
            data-testid="save-disabled-reason"
          >
            <Button
              size="sm"
              onClick={onSave}
              disabled={saveBlocked || busy}
              title={saveReason ? undefined : saveTitle}
              data-testid="designer-save"
            >
              <Save className="h-4 w-4" aria-hidden="true" />
              {t("common.save")}
            </Button>
          </DisabledReason>
        )}
      </div>
    </div>
  );
}
