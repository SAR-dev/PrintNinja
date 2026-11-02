import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { PACKS } from "@/lib/templates/packs";
import { PaperThumb } from "@/components/PaperThumb";
import { cn } from "@/lib/utils";

interface PackChooserProps {
  selectedId: string;
  onSelect: (id: string) => void;
}

export function PackChooser({ selectedId, onSelect }: PackChooserProps) {
  const { t } = useTranslation();
  const gridRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const idx = PACKS.findIndex((p) => p.id === selectedId);
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = (idx + 1) % PACKS.length;
        onSelect(PACKS[next].id);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = (idx - 1 + PACKS.length) % PACKS.length;
        onSelect(PACKS[prev].id);
      }
    },
    [selectedId, onSelect],
  );

  // Focus the selected card when selection changes via keyboard
  useEffect(() => {
    const el = gridRef.current?.querySelector<HTMLElement>(
      `[data-pack-id="${selectedId}"]`,
    );
    // Don't steal focus if user is typing elsewhere; only if grid had focus
    if (gridRef.current?.contains(document.activeElement)) {
      el?.focus();
    }
  }, [selectedId]);

  return (
    <div
      ref={gridRef}
      role="listbox"
      aria-label={t("designer.new_step_pack")}
      aria-orientation="vertical"
      onKeyDown={handleKeyDown}
      className="grid grid-cols-2 gap-3 sm:grid-cols-3"
    >
      {PACKS.map((pack) => {
        const isSelected = pack.id === selectedId;
        const nameKey = `designer.pack_${pack.id}_name` as const;
        const descKey = `designer.pack_${pack.id}_desc` as const;
        // Fall back to pack's bundled name/description if translation missing
        const name = t(nameKey, { defaultValue: pack.name });
        const desc = t(descKey, { defaultValue: pack.description });
        return (
          <button
            key={pack.id}
            type="button"
            role="option"
            aria-selected={isSelected}
            aria-label={`${name}, ${desc}`}
            data-pack-id={pack.id}
            data-testid={`pack-card-${pack.id}`}
            onClick={() => onSelect(pack.id)}
            className={cn(
              "flex flex-col items-center gap-2 rounded-lg border-2 p-3 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isSelected
                ? "border-primary bg-primary/5"
                : "border-border bg-card hover:border-primary/40 hover:bg-accent/50",
            )}
          >
            <PaperThumb widthMm={pack.page_w_mm} heightMm={pack.page_h_mm} />
            <div className="min-w-0">
              <p className="text-sm font-medium leading-tight">{name}</p>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {desc}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("designer.pack_size", { w: pack.page_w_mm, h: pack.page_h_mm })}
              </p>
            </div>
            {isSelected && (
              <span className="text-[10px] font-semibold uppercase tracking-widest text-primary">
                {t("designer.pack_selected")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
