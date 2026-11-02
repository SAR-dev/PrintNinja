export const BLANK_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body class="p-6 flex items-center justify-center min-h-full font-sans">
  <div class="text-center">
    <p class="text-lg text-slate-800">{{message}}</p>
  </div>
</body>
</html>`;

export const BLANK_CSS = `@page { margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`;

export function blankReadme(name: string): string {
  return [
    `# ${name}`,
    "",
    "A minimal starting point: one centred `{{message}}` placeholder on an 80 mm roll.",
    "",
    "## What it prints",
    "",
    "- The value of `message`, centred on the page.",
    "- Replace it with your own markup — the data contract is a single field.",
    "",
    "## Data contract",
    "",
    "Send JSON shaped like this. Every key is read as text.",
    "",
    "```json",
    "{",
    '  "message": "Hello"',
    "}",
    "```",
    "",
    "## Placeholders",
    "",
    "| Placeholder | Prints |",
    "| --- | --- |",
    "| `{{message}}` | Centred message |",
    "",
    "## Printer requirements",
    "",
    "- Paper: 80 × 200 mm roll, portrait",
    "- Language: PDF on any printer; raster for thermal printers",
    "- Margins: none. The template sets `@page { margin: 0 }`",
    "- Colour: black and white is enough",
    "",
    "## Changelog",
    "",
    "- v1 — initial version",
    "",
  ].join("\n");
}

export const BLANK_MOCK_DATA = {
  message: "Hello",
};

export const BLANK_PACK = {
  id: "blank",
  name: "Blank",
  description: "Minimal template with a single message",
  page_w_mm: 80,
  page_h_mm: 200,
  html: BLANK_HTML,
  css: BLANK_CSS,
  readme: blankReadme,
  mockData: BLANK_MOCK_DATA,
} as const;
