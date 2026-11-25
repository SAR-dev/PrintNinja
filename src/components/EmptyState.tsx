import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type LucideIcon } from "lucide-react";
import { AppLogo } from "@/components/AppLogo";
import { usePrefs } from "@/lib/prefs/PrefsProvider";

interface EmptyAction {
  label: string;
  onClick: () => void;
  variant?: "default" | "outline";
}

interface EmptyStateProps {
  /** Lucide glyph; omitted shows the app mark (branding-aware). */
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  /** Several choices where none is "the" action (e.g. pick a track). */
  actions?: EmptyAction[];
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  actions,
  className,
}: EmptyStateProps) {
  const { logo } = usePrefs();
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-16 text-center",
        className,
      )}
    >
      {/* Brand moment: the mark sits on the brand-soft tile at every size. */}
      <div className="mb-4 rounded-md bg-accent p-3 max-md:rounded-3xl max-md:p-5">
        {Icon ? (
          <Icon className="h-6 w-6 text-accent-foreground max-md:h-8 max-md:w-8" />
        ) : (
          <AppLogo src={logo} className="h-6 w-6 max-md:h-8 max-md:w-8" />
        )}
      </div>
      <h2 className="text-base font-medium max-md:font-semibold">{title}</h2>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {action && (
        <Button className="mt-4" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
      {actions && actions.length > 0 && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {actions.map((a) => (
            <Button
              key={a.label}
              variant={a.variant ?? "default"}
              onClick={a.onClick}
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
