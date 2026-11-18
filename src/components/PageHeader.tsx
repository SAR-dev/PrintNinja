import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons and other page-level actions. The primary action goes last. */
  children?: ReactNode;
  className?: string;
}

/**
 * The one place a page title, its description, and its actions live.
 *
 * Phones get a single compact row: the title and the actions share the line
 * when they fit (and wrap otherwise), and the description is dropped, so a
 * page starts with content instead of a block of chrome (DESIGN_IMPROVEMENTS
 * 4.5). On desktops the header sticks to the top of the page scroll and
 * collapses once scrolled — description hidden, tighter padding — so long
 * lists keep a slim bar of context.
 */
export function PageHeader({
  title,
  description,
  children,
  className,
}: PageHeaderProps) {
  const ref = useRef<HTMLElement>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The page's own scroll container, when rendered inside the app shell;
    // standalone (unit tests) there is no scroll to track.
    const scroller = el.closest<HTMLElement>("[data-slot='app-main']");
    if (!scroller) return;
    const update = () => setScrolled(scroller.scrollTop > 8);
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, []);

  return (
    <header
      ref={ref}
      data-slot="page-header"
      className={cn(
        "sticky top-0 z-20 -mx-4 border-b bg-background px-4 transition-[padding] duration-150 md:-mx-6 md:px-6",
        // Phone: one row (title + actions, wrapping when they do not fit).
        "flex flex-wrap items-center gap-x-3 gap-y-2",
        // Desktop: the original two-part row, bottom aligned.
        "md:flex-row md:flex-nowrap md:items-end md:justify-between md:gap-3",
        scrolled ? "py-2" : "pt-0 pb-3 md:pb-4",
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-1 md:flex-none">
        <h1 className="truncate text-xl font-semibold leading-tight tracking-tight">
          {title}
        </h1>
        {description && !scrolled && (
          <p className="hidden max-w-prose text-sm text-muted-foreground md:block">
            {description}
          </p>
        )}
      </div>
      {children && (
        <div
          data-slot="page-actions"
          className="flex flex-wrap items-center gap-2"
        >
          {children}
        </div>
      )}
    </header>
  );
}
