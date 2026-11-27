import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { PaperThumb } from "@/components/PaperThumb";
import { SCENE_STARTERS, starterSizeMm } from "@/lib/scene/starters";
import { cn } from "@/lib/utils";

interface SceneStarterChooserProps {
  selectedId: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}

/**
 * The starter label picker: the label track's counterpart of the
 * document `PackChooser` — the same card grid, listbox semantics and
 * arrow-key movement, over the bundled label starters.
 */
export function SceneStarterChooser({
  selectedId,
  onSelect,
  disabled,
}: SceneStarterChooserProps) {
  const { t } = useTranslation();
  const gridRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled) return;
      const idx = SCENE_STARTERS.findIndex((s) => s.id === selectedId);
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        onSelect(SCENE_STARTERS[(idx + 1) % SCENE_STARTERS.length].id);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = SCENE_STARTERS.length;
        onSelect(SCENE_STARTERS[(idx - 1 + n) % n].id);
      }
    },
    [selectedId, onSelect, disabled],
  );

  // Follow the selection with focus when the grid itself had it, so the
  // arrow keys keep moving; never steal focus from the name field.
  useEffect(() => {
    const el = gridRef.current?.querySelector<HTMLElement>(
      `[data-starter-id="${selectedId}"]`,
    );
    if (gridRef.current?.contains(document.activeElement)) el?.focus();
  }, [selectedId]);

  return (
    <div
      ref={gridRef}
      role="listbox"
      aria-label={t("scene.starter_pick")}
      aria-orientation="vertical"
      onKeyDown={handleKeyDown}
      className="grid grid-cols-2 gap-3 sm:grid-cols-3"
    >
      {SCENE_STARTERS.map((starter) => {
        const isSelected = starter.id === selectedId;
        const name = t(`scene.starter_${starter.id}_name`, {
          defaultValue: starter.name,
        });
        const desc = t(`scene.starter_${starter.id}_desc`, {
          defaultValue: starter.description,
        });
        const { w, h } = starterSizeMm(starter);
        return (
          <button
            key={starter.id}
            type="button"
            role="option"
            aria-selected={isSelected}
            aria-label={`${name}, ${desc}`}
            data-starter-id={starter.id}
            data-testid={`scene-starter-${starter.id}`}
            disabled={disabled}
            onClick={() => onSelect(starter.id)}
            className={cn(
              "flex flex-col items-center gap-2 rounded-lg border-2 p-3 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
              isSelected
                ? "border-primary bg-primary/5"
                : "border-border bg-card hover:border-primary/40 hover:bg-accent/50",
            )}
          >
            <PaperThumb widthMm={w} heightMm={h} />
            <div className="min-w-0">
              <p className="text-sm font-medium leading-tight">{name}</p>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {desc}
              </p>
              <p className="mt-1 text-caption text-muted-foreground">
                {t("scene.template_size", { w, h })}
              </p>
            </div>
            {isSelected && (
              <span className="text-caption font-semibold uppercase tracking-widest text-primary">
                {t("designer.pack_selected")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
