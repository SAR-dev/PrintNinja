import * as React from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface Props extends React.HTMLAttributes<HTMLSpanElement> {
  /** Why the control is disabled. Empty means it is enabled: no wrapper, no tooltip. */
  reason?: string;
  children: React.ReactNode;
}

/**
 * Explains a disabled control. Browsers send no pointer or focus events from a
 * disabled button, so the tooltip hangs on a wrapper that can still be hovered
 * and tabbed to; the control inside stops taking pointer events so the hover
 * lands on the wrapper. Pass `reason` only while the control is disabled.
 */
export function DisabledReason({
  reason,
  children,
  className,
  ...props
}: Props) {
  if (!reason) return <>{children}</>;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className={cn(
              "inline-flex cursor-not-allowed rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&>*]:pointer-events-none",
              className,
            )}
            {...props}
          >
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
