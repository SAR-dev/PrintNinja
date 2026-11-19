import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    // Template-authoring code and tests hold class names as *data* (Handlebars
    // examples such as `w-[{{width}}mm]`, starter template markup). Scanning them
    // would emit junk rules into the app's own stylesheet, and some are invalid
    // CSS. Templates get their own stylesheet from `compileTemplateCss`.
    "!./src/lib/templates/**",
    "!./src/test/**",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      // Named type scale: 12px is the floor for any UI text (14px for phone
      // body copy), so text-[Npx] has nowhere to go — see textScale.test.ts.
      fontSize: {
        caption: ["0.75rem", { lineHeight: "1rem" }], // 12/16 — the floor
        "body-sm": ["0.8125rem", { lineHeight: "1.25rem" }], // 13/20
        body: ["0.875rem", { lineHeight: "1.375rem" }], // 14/22
        title: ["1.125rem", { lineHeight: "1.5rem" }], // 18/24
        display: ["1.5rem", { lineHeight: "2rem" }], // 24/32
      },
      // Repeated fixed widths collapse to a few names: form fields and the
      // designer side panel.
      width: {
        control: "var(--control-h)",
        "field-sm": "140px",
        field: "160px",
        "field-lg": "180px",
        panel: "300px",
      },
      // Sheet heights: how tall a dialog, sheet, or preview region may grow.
      // dvh everywhere, so a phone's URL bar never clips them.
      height: {
        control: "var(--control-h)",
        "sheet-sm": "40dvh",
        sheet: "60dvh",
        "sheet-lg": "70dvh",
        "sheet-xl": "85dvh",
      },
      maxHeight: {
        "sheet-sm": "40dvh",
        sheet: "60dvh",
        "sheet-lg": "70dvh",
        "sheet-xl": "85dvh",
      },
      fontFamily: {
        sans: ["IBM Plex Sans", "Segoe UI", "-apple-system", "BlinkMacSystemFont", "Roboto", "Noto Sans", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", "Meiryo", "Noto Sans JP", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "Cascadia Mono", "Consolas", "monospace"],
      },
      colors: {
        success: { DEFAULT: "hsl(var(--success))", soft: "hsl(var(--success-soft))" },
        warning: { DEFAULT: "hsl(var(--warning))", soft: "hsl(var(--warning-soft))" },
        danger: { DEFAULT: "hsl(var(--danger))", soft: "hsl(var(--danger-soft))" },
        info: { DEFAULT: "hsl(var(--info))", soft: "hsl(var(--info-soft))" },
        neutral: { DEFAULT: "hsl(var(--neutral))", soft: "hsl(var(--neutral-soft))" },
        // Non-status accent ("new", "recommended", brand moments) — see the
        // highlight tokens in index.css; never used for state.
        highlight: { DEFAULT: "hsl(var(--highlight))", soft: "hsl(var(--highlight-soft))" },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
