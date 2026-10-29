import { useTranslation } from "react-i18next";
import { MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Phone header menu for the Designer: New template plus the
 * Public/Private toggle live here so the page keeps only the sticky
 * view tabs with Save. Same strings and test ids as the desktop
 * toolbar; the two never render together.
 */
export function DesignerOverflowMenu({
  onNew,
  published,
  remoteId,
  readOnly,
  busy,
  onVisibilityChange,
}: {
  onNew: () => void;
  published: boolean;
  remoteId: string | null;
  readOnly: boolean;
  busy: boolean;
  onVisibilityChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  // The state stays visible next to the menu; the actions hide inside.
  const status = readOnly
    ? t("designer.read_only")
    : !remoteId
      ? t("designer.only_local")
      : published
        ? t("designer.visibility_public")
        : t("designer.visibility_private");
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">{status}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={t("nav.more")}>
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onNew}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("designer.newTemplate")}
          </DropdownMenuItem>
          {readOnly ? (
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("designer.read_only")}
            </DropdownMenuLabel>
          ) : !remoteId ? (
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("designer.only_local")}
            </DropdownMenuLabel>
          ) : (
            <DropdownMenuCheckboxItem
              data-testid="template-visibility-menu"
              checked={published}
              disabled={busy}
              onCheckedChange={onVisibilityChange}
            >
              {published
                ? t("designer.visibility_public")
                : t("designer.visibility_private")}
            </DropdownMenuCheckboxItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
