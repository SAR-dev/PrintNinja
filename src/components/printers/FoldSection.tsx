import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  /** Id of the folded panel (the toggle's `aria-controls`). */
  id: string;
  title: string;
  /** What is inside, shown in the header while folded (values, "Not set"). */
  summary: string;
  open: boolean;
  onToggle: () => void;
  "data-testid": string;
  children: ReactNode;
}

/**
 * A bordered section of the printer sheet that stays folded until opened.
 * The header carries a one-line summary, so folding hides the clutter but
 * not what is set. The panel unmounts while folded.
 */
export function FoldSection({
  id,
  title,
  summary,
  open,
  onToggle,
  "data-testid": testId,
  children,
}: Props) {
  return (
    <div className="rounded-md border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        data-testid={testId}
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 rounded-md p-3 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {title}
        <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
          {summary}
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 transition-transform",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </span>
      </button>
      {open && (
        <div id={id} className="space-y-4 border-t p-3">
          {children}
        </div>
      )}
    </div>
  );
}
