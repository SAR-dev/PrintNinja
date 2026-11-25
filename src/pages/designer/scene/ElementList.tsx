/**
 * The element list of the scene designer: every element of the open
 * template, indented by its container, with reorder and delete in a
 * per-row menu. Ported from PrintNinja-Next's
 * `app/ui/src/components/editor/element-list.tsx` (the old app has no
 * ActionMenu — the row menu is a plain dropdown).
 */
import {
  Barcode,
  ChevronDown,
  ChevronUp,
  Frame,
  Image as ImageIcon,
  type LucideIcon,
  Minus,
  MoreHorizontal,
  QrCode,
  Rows3,
  Square,
  Trash2,
  Type,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  elementLabel,
  type Path,
  type Selection,
} from "@/lib/scene/editor-model";
import type { Element } from "@/lib/scene/schema";

/** The list icon of each element type. */
const TYPE_ICONS: Record<Element["type"], LucideIcon> = {
  text: Type,
  line: Minus,
  rect: Square,
  frame: Frame,
  barcode: Barcode,
  qr: QrCode,
  image: ImageIcon,
  group: Rows3,
};

interface RowInfo {
  el: Element;
  path: Path;
  depth: number;
  index: number;
  count: number;
}

/**
 * The template's elements, one row each, nested a group's rows and a
 * frame's children one level down. Tapping a row selects it (tapping
 * the selected row clears the selection).
 */
export function ElementList({
  elements,
  basePath,
  selection,
  onSelect,
  onMove,
  onDelete,
}: {
  elements: Element[];
  basePath: Path;
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
  onMove: (path: Path, delta: number) => void;
  onDelete: (path: Path) => void;
}) {
  const { t } = useTranslation();
  const rows: RowInfo[] = [];
  const collect = (els: Element[], base: Path, depth: number) => {
    els.forEach((el, index) => {
      const path: Path = [...base, index];
      rows.push({ el, path, depth, index, count: els.length });
      if (el.type === "group") collect(el.items, path, depth + 1);
      else if (el.type === "frame") collect(el.children, path, depth + 1);
    });
  };
  collect(elements, basePath, basePath.length);

  if (rows.length === 0) {
    return (
      <span className="text-body-sm text-muted-foreground">
        {t("scene.element_empty")}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {rows.map((row) => {
        const Icon = TYPE_ICONS[row.el.type];
        const isSel =
          selection !== null &&
          row.path.length === selection.path.length &&
          row.path.every((n, i) => n === selection.path[i]);
        return (
          <div
            key={row.path.join("/")}
            style={{ marginLeft: (row.depth - 1) * 16 }}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${
              isSel ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-body-sm"
              onClick={() => onSelect(isSel ? null : { path: row.path })}
            >
              {elementLabel(row.el)}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  aria-label={t("scene.more_actions")}
                >
                  <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => onMove(row.path, -1)}
                  disabled={row.index === 0}
                >
                  <ChevronUp className="h-4 w-4" aria-hidden="true" />
                  {t("scene.move_up")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => onMove(row.path, 1)}
                  disabled={row.index === row.count - 1}
                >
                  <ChevronDown className="h-4 w-4" aria-hidden="true" />
                  {t("scene.move_down")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => onDelete(row.path)}
                  className="text-destructive"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  {t("scene.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
    </div>
  );
}

/** The "add an element" buttons of a container (root, row or frame). */
export function AddElement({
  types,
  onAdd,
}: {
  types: readonly string[];
  onAdd: (type: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {types.map((type) => {
        const Icon = TYPE_ICONS[type as Element["type"]];
        return (
          <Button
            key={type}
            type="button"
            variant="secondary"
            size="icon"
            aria-label={type}
            onClick={() => onAdd(type)}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </Button>
        );
      })}
    </div>
  );
}
