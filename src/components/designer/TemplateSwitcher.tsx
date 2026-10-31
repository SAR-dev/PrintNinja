import { Command } from "cmdk";
import { Check, ChevronsUpDown, FileText } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SwitcherTemplate {
  id: number;
  name: string;
  origin?: string | null;
}

interface Props<T extends SwitcherTemplate> {
  templates: T[];
  currentTemplateId: number | null;
  onSelect: (tpl: T) => void;
  disabled?: boolean;
}

/**
 * Picks the template being edited. A button opens a searchable list, grouped
 * Mine / Saved, so the choice scales to many templates and costs no column
 * space. It only switches: renaming lives in the toolbar's name field.
 */
export function TemplateSwitcher<T extends SwitcherTemplate>({
  templates,
  currentTemplateId,
  onSelect,
  disabled = false,
}: Props<T>) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();

  // Close on a press outside, as a menu would.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const groups = (
    [
      ["own", "templates.tab_mine"],
      ["saved", "templates.tab_saved"],
    ] as const
  ).map(([origin, labelKey]) => ({
    origin,
    labelKey,
    items: templates.filter((tpl) =>
      origin === "saved" ? tpl.origin === "saved" : tpl.origin !== "saved",
    ),
  }));

  const choose = (tpl: T) => {
    setOpen(false);
    trigger.current?.focus();
    onSelect(tpl);
  };

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={t("designer.switch_template")}
        title={t("designer.switch_template")}
        onClick={() => setOpen((v) => !v)}
      >
        <FileText className="h-4 w-4" aria-hidden="true" />
        {t("designer.templates")}
        <ChevronsUpDown
          className="h-3.5 w-3.5 text-muted-foreground"
          aria-hidden="true"
        />
      </Button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-80 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
          <Command label={t("designer.switch_template")}>
            <Command.Input
              autoFocus
              placeholder={t("designer.search_templates")}
              className="w-full border-b bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
            />
            <Command.List id={listId} className="max-h-72 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-4 text-center text-xs text-muted-foreground">
                {t("designer.no_template_match")}
              </Command.Empty>
              {groups.map(
                ({ origin, labelKey, items }) =>
                  items.length > 0 && (
                    <Command.Group
                      key={origin}
                      heading={t(labelKey)}
                      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
                    >
                      {items.map((tpl) => {
                        const active = tpl.id === currentTemplateId;
                        return (
                          <Command.Item
                            key={tpl.id}
                            // The id keeps two templates with the same name apart.
                            value={`${tpl.name} #${tpl.id}`}
                            onSelect={() => choose(tpl)}
                            aria-current={active ? "true" : undefined}
                            className={cn(
                              "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm [@media(pointer:coarse)]:min-h-11",
                              "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
                              active && "font-medium",
                            )}
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {tpl.name}
                            </span>
                            {active && (
                              <Check
                                className="h-4 w-4 shrink-0"
                                aria-hidden="true"
                              />
                            )}
                          </Command.Item>
                        );
                      })}
                    </Command.Group>
                  ),
              )}
            </Command.List>
          </Command>
        </div>
      )}
    </div>
  );
}
