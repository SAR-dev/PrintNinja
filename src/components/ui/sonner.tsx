import { Toaster as Sonner } from "sonner";
import { isAndroid } from "@/lib/platform";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * App toaster: status-token colors per type (UI_GUIDE.md, not sonner's
 * own palette), two visible at most, and a close button everywhere.
 * Phones sit bottom-center above the bottom nav (plus the sticky Print
 * bar on /print) via `--toast-offset-bottom`, which Layout keeps true
 * to the real chrome heights; desktop stays bottom-right.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      position={isAndroid() ? "bottom-center" : "bottom-right"}
      mobileOffset={{ bottom: "var(--toast-offset-bottom, 24px)" }}
      visibleToasts={2}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:rounded-lg group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          success:
            "group-[.toaster]:bg-success-soft group-[.toaster]:text-success group-[.toaster]:border-success/30",
          info: "group-[.toaster]:bg-info-soft group-[.toaster]:text-info group-[.toaster]:border-info/30",
          warning:
            "group-[.toaster]:bg-warning-soft group-[.toaster]:text-warning group-[.toaster]:border-warning/30",
          error:
            "group-[.toaster]:bg-danger-soft group-[.toaster]:text-danger group-[.toaster]:border-danger/30",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
