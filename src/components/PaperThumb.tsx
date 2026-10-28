import { cn } from "@/lib/utils";

interface PaperThumbProps {
  /** Page width in mm. */
  widthMm: number;
  /** Page height in mm. */
  heightMm: number;
  className?: string;
}

/** Longest edge of the paper, in rem, inside the 3.5rem tile. */
const MAX_EDGE_REM = 2.5;
/** Keeps a 58 mm roll or a very long receipt from becoming a sliver. */
const MIN_EDGE_REM = 1.1;

/**
 * A miniature of the template's page, drawn to its real proportions: a 4x6
 * label looks like a label, an 80 mm roll like a tall receipt, A4 like a
 * sheet. It is decoration for the card (the size is also written as text),
 * so it is hidden from assistive technology.
 */
export function PaperThumb({ widthMm, heightMm, className }: PaperThumbProps) {
  const w = widthMm > 0 ? widthMm : 1;
  const h = heightMm > 0 ? heightMm : 1;
  const scale = MAX_EDGE_REM / Math.max(w, h);
  const width = Math.max(MIN_EDGE_REM, w * scale);
  const height = Math.max(MIN_EDGE_REM, h * scale);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-accent",
        className,
      )}
    >
      <span
        className="flex flex-col gap-[3px] rounded-[3px] bg-card p-[5px] shadow-[0_1px_3px_hsl(var(--foreground)/0.22)]"
        style={{ width: `${width}rem`, height: `${height}rem` }}
      >
        <span className="h-[3px] w-2/3 rounded-full bg-primary/70" />
        <span className="h-[2px] w-full rounded-full bg-muted-foreground/30" />
        <span className="h-[2px] w-4/5 rounded-full bg-muted-foreground/30" />
        <span className="mt-auto h-[5px] w-full rounded-[1px] bg-foreground/60" />
      </span>
    </span>
  );
}
