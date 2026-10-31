import { cn } from "@/lib/utils";

/** Default PrintNinja mark, served from /public/app-icon.svg. */
const DEFAULT_LOGO_SRC = "/app-icon.svg";

/**
 * PrintNinja mark. Pass `src` (a data URL from Settings → Branding) to show
 * a custom logo instead of the default app icon.
 */
export function AppLogo({
  className,
  src,
}: {
  className?: string;
  src?: string | null;
}) {
  return (
    <img
      src={src || DEFAULT_LOGO_SRC}
      alt=""
      aria-hidden="true"
      className={cn("h-7 w-7 shrink-0 rounded-sm object-contain", className)}
    />
  );
}
