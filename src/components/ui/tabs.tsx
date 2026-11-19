import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, onScroll, ...props }, ref) => {
  const innerRef = React.useRef<HTMLDivElement | null>(null);
  const [fadeRight, setFadeRight] = React.useState(false);
  const setRefs = (node: HTMLDivElement | null) => {
    innerRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };
  // On phones, non-segmented tab rows stack full-width (max-md: classes
  // below), where nothing is ever cut off; only segmented strips can
  // overflow.
  const phoneStacked =
    "data-variant" in props ? props["data-variant"] !== "segmented" : true;
  // Recompute after every render: tab labels carry counts that change
  // width, and the active tab can move programmatically (not just by
  // tapping a visible trigger).
  React.useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const horizontal = getComputedStyle(el).flexDirection !== "column";
    setFadeRight(
      horizontal && el.scrollWidth - el.clientWidth - el.scrollLeft > 4,
    );
    if (horizontal) {
      const active = el.querySelector<HTMLElement>('[data-state="active"]');
      if (!active) return;
      const start = el.scrollLeft;
      if (
        active.offsetLeft < start ||
        active.offsetLeft + active.offsetWidth > start + el.clientWidth
      ) {
        // jsdom has no scrollIntoView; in the app this keeps the active
        // tab in view when it changes without a tap on the strip.
        active.scrollIntoView?.({ inline: "nearest", block: "nearest" });
      }
    }
  });
  return (
    <TabsPrimitive.List
      ref={setRefs}
      data-slot="tabs-list"
      data-fade={fadeRight ? "right" : undefined}
      onScroll={(e) => {
        const el = e.currentTarget;
        setFadeRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 4);
        onScroll?.(e);
      }}
      className={cn(
        // max-w-full + overflow-x-auto: on a phone a long tab row scrolls sideways
        // instead of being clipped by the screen edge. On coarse pointers the strip
        // grows so its 44px triggers are not clipped (h-10 still wins on fine pointers).
        "inline-flex h-10 max-w-full items-center justify-start overflow-x-auto rounded-md bg-muted p-1 text-muted-foreground [@media(pointer:coarse)]:min-h-[3.25rem] sm:justify-center",
        phoneStacked &&
          "max-md:flex max-md:flex-col max-md:w-full max-md:gap-1 max-md:rounded-[1rem]",
        className,
      )}
      {...props}
    />
  );
});
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    data-slot="tabs-trigger"
    className={cn(
      // Touch targets: 44px tall on coarse pointers, matching Button/Input/Select.
      "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all [@media(pointer:coarse)]:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
