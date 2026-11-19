import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;
const SheetOverlay = DialogPrimitive.Overlay;
const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    side?: "top" | "bottom" | "left" | "right";
  }
>(({ side = "right", className, children, ...props }, ref) => {
  const { t } = useTranslation();
  return (
    <SheetPortal>
      <DialogPrimitive.Overlay
        data-slot="overlay"
        className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 max-md:bg-[hsl(var(--foreground)/0.45)]"
      />
      <DialogPrimitive.Content
        ref={ref}
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "fixed z-50 gap-4 bg-background p-6 shadow-lg",
          // top-[env(safe-area-inset-top)]: on edge-to-edge Android the webview
          // runs under the status bar / punch hole, so anchoring at top-0
          // clipped the sheet header and close button off screen.
          side === "right" &&
            "bottom-0 top-[env(safe-area-inset-top)] right-0 w-3/4 border-l sm:max-w-sm",
          side === "left" &&
            "bottom-0 top-[env(safe-area-inset-top)] left-0 w-3/4 border-r sm:max-w-sm",
          side === "top" && "inset-x-0 top-[env(safe-area-inset-top)] border-b",
          side === "bottom" &&
            "inset-x-0 bottom-0 border-t data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom data-[state=open]:duration-300 data-[state=closed]:duration-200 max-md:border-t-0 max-md:rounded-t-[1.75rem] max-md:shadow-[0_-12px_40px_-12px_hsl(var(--foreground)/0.3)] max-md:before:content-[''] max-md:before:absolute max-md:before:top-2 max-md:before:left-1/2 max-md:before:w-10 max-md:before:h-[0.3125rem] max-md:before:-translate-x-1/2 max-md:before:rounded-full max-md:before:bg-[hsl(var(--foreground)/0.18)] max-md:[&>header]:pt-7 max-md:[&>div:first-child]:pt-7 max-md:[&_li>a]:min-h-14 max-md:[&_li>a]:gap-3.5 max-md:[&_li>a]:px-3 max-md:[&_li>a]:rounded-2xl max-md:[&_li>a]:text-[0.9375rem] max-md:[&_li>a]:transition-[background-color_var(--dur-fast)] max-md:[&_li>a:active]:bg-muted max-md:[&_li>a_svg]:box-content max-md:[&_li>a_svg]:h-5 max-md:[&_li>a_svg]:w-5 max-md:[&_li>a_svg]:p-2 max-md:[&_li>a_svg]:rounded-xl max-md:[&_li>a_svg]:bg-secondary max-md:[&_li>a[aria-current=page]_svg]:bg-primary max-md:[&_li>a[aria-current=page]_svg]:text-primary-foreground",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-1 top-1 flex h-10 w-10 items-center justify-center rounded-md opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11">
          <X className="h-4 w-4" />
          <span className="sr-only">{t("common.close")}</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </SheetPortal>
  );
});
SheetContent.displayName = DialogPrimitive.Content.displayName;

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetPortal,
  SheetOverlay,
  SheetContent,
};
