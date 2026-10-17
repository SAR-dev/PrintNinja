/*
 * Tailwind config for the PRINT stylesheet bundle.
 *
 * This is deliberately separate from `tailwind.config.ts`, which styles the
 * Tauri application shell. Rendered templates are a different environment:
 * they are printed on paper (or a thermal roll), have no dark mode, no
 * animation, no container queries, and their classes are authored at runtime
 * by the user, so nothing can be discovered by scanning source files.
 *
 * Everything the user could plausibly type is therefore safelisted.
 * Regenerate with `pnpm build:templates:css`.
 */
import type { Config } from "tailwindcss";

/**
 * Utilities offered in the Designer's insert palette.
 *
 * Deliberately a focused print subset, not the full Tailwind surface: this
 * whole stylesheet is inlined into every print job, and safelisting the full
 * surface across all variants produced ~430 KB of CSS per job.
 *
 * Keep in sync with `TEMPLATE_UTILITIES` in
 * `src/lib/templates/templateCss.ts` — a unit test fails if they drift.
 */
const PALETTE = [
  // display / layout
  "block", "inline-block", "inline", "flex", "inline-flex", "grid",
  "table", "hidden",
  "text-left", "text-center", "text-right",
  "justify-start", "justify-end", "justify-center", "justify-between",
  "items-start", "items-end", "items-center", "items-stretch",
  // spacing — printer margins: small steps only, no 96-unit scale
  "gap-1", "gap-2", "gap-3", "gap-4", "gap-6", "gap-8",
  "space-y-1", "space-y-2", "space-y-3", "space-y-4",
  "p-0", "p-1", "p-2", "p-3", "p-4", "p-6", "p-8",
  "px-1", "px-2", "px-3", "px-4", "px-6",
  "py-1", "py-2", "py-3", "py-4", "py-6",
  "pt-2", "pt-4", "pt-6", "pb-2", "pb-4", "pb-6",
  "pl-2", "pl-4", "pr-2", "pr-4", "mx-auto",
  "mt-1", "mt-2", "mt-4", "mt-6", "mt-8",
  "mb-1", "mb-2", "mb-3", "mb-4", "mb-6", "mb-8",
  // grid
  "grid-cols-2", "grid-cols-3", "grid-cols-4", "grid-cols-6",
  "col-span-2", "col-span-3", "col-span-full",
  // sizing
  "w-1\/2", "w-2\/3", "w-full", "w-auto",
  "h-4", "h-6", "h-8", "h-10", "h-12", "h-16", "h-full",
  "min-h-full", "max-w-full", "max-w-md", "max-w-lg", "max-w-xl",
  // type
  "text-xs", "text-sm", "text-base", "text-lg", "text-xl",
  "text-2xl", "text-3xl", "text-4xl", "text-5xl",
  "font-light", "font-normal", "font-medium", "font-semibold", "font-bold",
  "font-black", "font-sans", "font-serif", "font-mono",
  "uppercase", "lowercase", "capitalize", "italic", "no-underline",
  "leading-tight", "leading-normal", "leading-relaxed",
  "tracking-wide", "tracking-wider", "tracking-widest",
  "whitespace-nowrap", "whitespace-pre-wrap", "truncate",
  "underline", "line-through", "align-top", "align-middle", "align-bottom",
  // colour — only the steps a template realistically needs
  "text-white", "text-black",
  "text-gray-300", "text-gray-400", "text-gray-500", "text-gray-600",
  "text-gray-700", "text-gray-800", "text-gray-900",
  "text-slate-300", "text-slate-400", "text-slate-500", "text-slate-600",
  "text-slate-700", "text-slate-800", "text-slate-900",
  "text-red-500", "text-red-600", "text-emerald-600", "text-emerald-700",
  "text-amber-600", "text-amber-700", "text-blue-600", "text-blue-700",
  "text-green-700",
  "bg-white", "bg-black", "bg-transparent",
  "bg-gray-50", "bg-gray-100", "bg-gray-200", "bg-gray-700", "bg-gray-800",
  "bg-gray-900",
  "bg-slate-50", "bg-slate-100", "bg-slate-200", "bg-slate-500",
  "bg-slate-800", "bg-slate-900",
  "bg-red-50", "bg-red-100", "bg-red-600",
  "bg-emerald-50", "bg-emerald-100", "bg-emerald-600",
  "bg-amber-50", "bg-amber-100", "bg-amber-400",
  "bg-blue-50", "bg-blue-100", "bg-blue-600",
  "bg-green-50", "bg-green-100", "bg-green-600",
  // borders
  "border", "border-0", "border-2", "border-4",
  "border-t", "border-r", "border-b", "border-l",
  "border-t-2", "border-b-2", "border-t-4",
  "border-solid", "border-dashed", "border-dotted", "border-none",
  "border-white", "border-black",
  "border-gray-100", "border-gray-200", "border-gray-300",
  "border-gray-700", "border-gray-800",
  "border-slate-100", "border-slate-200", "border-slate-300",
  "border-slate-400", "border-slate-500", "border-slate-600",
  "border-slate-700", "border-slate-800",
  "border-red-200", "border-red-500",
  "border-emerald-200", "border-emerald-500",
  "border-amber-200", "border-amber-400",
  "border-blue-200", "border-blue-500",
  // shape
  "rounded-none", "rounded-sm", "rounded", "rounded-md", "rounded-lg",
  "rounded-xl", "rounded-full",
  "rounded-t", "rounded-b", "rounded-tl", "rounded-tr",
  "rounded-br", "rounded-bl",
  "shadow-none", "shadow-sm", "shadow", "shadow-md", "shadow-lg",
  // misc
  "opacity-50", "opacity-75", "opacity-100",
  "object-contain", "object-cover", "relative", "absolute",
  "top-0", "right-0", "bottom-0", "left-0", "inset-0",
  "table-auto", "table-fixed", "border-collapse", "border-separate",
  "list-none", "list-inside", "appearance-none",
  "overflow-hidden", "antialiased", "select-none",
];

/**
 * Variants worth emitting for those utilities.
 *
 * Interactive states (hover/focus/active) are meaningless on paper and dark
 * mode only matters for the on-screen preview, so both are excluded to keep
 * the inlined bundle small.
 */
const PALETTE_VARIANTS: string[] = ["print", "dark"];

/**
 * Expand the palette: the bare utilities plus each variant-prefixed form.
 *
 * The empty prefix is essential. Without it Tailwind only emitted
 * `print:flex`, `dark:flex` … so a plain `class="flex"` written by the user
 * was scanned out of the starter templates or not at all, and silently had
 * no effect in the printed output.
 */
const safelist: string[] = [];
for (const variant of ["", ...PALETTE_VARIANTS]) {
  for (const utility of PALETTE) {
    safelist.push(variant ? `${variant}:${utility}` : utility);
  }
}


/** Custom component classes defined in `templates.src.css`. */
const safelistPatterns = [
  {
    pattern:
      /^(page-break-before|page-break-after|page-break-inside-avoid|no-print|print-only|barcode)$/,
    variants: ["print", "sm", "md", "lg", "dark"],
  },
];

const config: Config = {
  // Paper has no dark mode, no transitions worth waiting for, and no
  // interactive hover states. Strip everything we do not need so the
  // inlined stylesheet stays small enough to embed in every job.
  darkMode: "class",
  content: [
    // The bundled starter templates live in a .ts file as template literals.
    "./src/lib/templates/defaultTemplate.ts",
    "./src/styles/templates.src.css",
  ],
  safelist: [...safelist, ...safelistPatterns],
  corePlugins: {
    // Not useful on paper.
    preflight: true,
    // Motion is invisible and wastes ink/toner on a receipt roll.
    transitionProperty: false,
    transitionDuration: false,
    transitionTimingFunction: false,
    transitionDelay: false,
    animation: false,
    // Template authors control these themselves via inline styles.
    container: false,
  },
  theme: {
    extend: {
      fontFamily: {
        // Thermal printers ship very few fonts; keep the stack small and
        // let the user's uploaded font win via the inline `font-family`.
        sans: [
          "Segoe UI",
          "Roboto",
          "Noto Sans",
          "-apple-system",
          "BlinkMacSystemFont",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: ["Consolas", "DejaVu Sans Mono", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
