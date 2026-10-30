import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type LucideIcon } from "lucide-react";
import { AppLogo } from "@/components/AppLogo";
import { usePrefs } from "@/lib/prefs/PrefsProvider";

interface EmptyStateProps {
  /** Lucide glyph; omitted shows the app mark (branding-aware). */
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
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
      <div className="mb-4 rounded-md bg-muted p-3 max-md:rounded-3xl max-md:bg-accent max-md:p-5">
        {Icon ? (
          <Icon className="h-6 w-6 text-muted-foreground max-md:h-8 max-md:w-8 max-md:text-accent-foreground" />
        ) : (
          <AppLogo
            src={logo}
            className="h-6 w-6 max-md:h-8 max-md:w-8"
          />
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
    </div>
  );
}
