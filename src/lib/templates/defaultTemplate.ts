/** HTML of the bundled example, Shipping Label 4x6. Every new template
 * starts from it, and the README's template-design section walks it. */
export const DEFAULT_TEMPLATE_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body class="p-4 text-xs font-sans">
  <!-- Label border -->
  <div class="border-4 border-slate-800 rounded-lg p-3 h-full flex flex-col justify-between">
    <div class="space-y-2">
      <div class="flex justify-between items-center border-b border-slate-300 pb-2">
        <span class="text-[10px] uppercase tracking-widest text-slate-500">PrintNinja Logistics</span>
        <span class="text-[10px] font-mono text-slate-600">Order #{{order.id}}</span>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="bg-slate-100 rounded p-2">
          <p class="text-[9px] uppercase tracking-wider font-semibold text-slate-500 mb-1">From</p>
          <p class="text-[11px] font-medium">{{store.name}}</p>
          <p class="text-[10px] text-slate-600">{{store.address}}</p>
        </div>
        <div class="bg-slate-50 rounded p-2">
          <p class="text-[9px] uppercase tracking-wider font-semibold text-slate-500 mb-1">To</p>
          <p class="text-[11px] font-bold">{{customer.name}}</p>
          <p class="text-[10px] text-slate-700">{{customer.address}}</p>
          <p class="text-[10px] text-slate-700">{{customer.city}} {{customer.zip}}</p>
          <p class="text-[10px] font-semibold text-slate-900">{{customer.country}}</p>
        </div>
      </div>

      <div class="bg-slate-100 rounded p-2">
        <p class="text-[9px] uppercase tracking-wider font-semibold text-slate-500 mb-1">Contents</p>
        <p class="text-[10px] text-slate-700">
          {{#each order.items}}{{name}} (×{{qty}}){{#unless @last}}, {{/unless}}{{/each}}
        </p>
      </div>
    </div>

    <div class="border-t border-slate-300 pt-2 text-center">
      {{barcode "code128" order.tracking width=70 text=false}}
      <p class="font-mono text-base font-bold tracking-widest">{{order.tracking}}</p>
      <p class="text-[9px] text-slate-400 mt-1">Tracking number</p>
    </div>
  </div>
</body>
</html>`;

export const DEFAULT_TEMPLATE_CSS = `@page { margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`;

/**
 * README for the bundled label. Plain Markdown only (headings, lists,
 * GFM tables, fenced code, inline code): the README preview renders
 * exactly that, with raw HTML shown as text and comments dropped, so
 * nothing here depends on styles the preview cannot draw. The data
 * contract and placeholder table mirror DEFAULT_TEMPLATE_HTML; the
 * default-template test fails if they drift apart.
 */
export function defaultTemplateReadme(name: string): string {
  return [
    `# ${name}`,
    "",
    "A 4 × 6 in shipping label: sender, recipient, a one-line list of the contents and a Code 128 tracking barcode.",
    "",
    "## What it prints",
    "",
    "- A header with the company line and the order number.",
    "- **From** (the store) and **To** (the customer) address blocks.",
    "- **Contents**, a comma-separated list of the order items with quantities.",
    "- The tracking number as a Code 128 barcode with the number printed below it.",
    "",
    "## Data contract",
    "",
    "Send JSON shaped like this. Every key is read as text; `order.items` is a list.",
    "",
    "```json",
    "{",
    '  "store": { "name": "PrintNinja Cafe", "address": "123 Main Street, Dhaka" },',
    '  "customer": {',
    '    "name": "John Doe",',
    '    "address": "45 Oak Lane, Apt 2",',
    '    "city": "Gulshan",',
    '    "zip": "1212",',
    '    "country": "Bangladesh"',
    "  },",
    '  "order": {',
    '    "id": "1042",',
    '    "tracking": "PN-7X9K-4242-BD",',
    '    "items": [',
    '      { "name": "Green Tea (Medium)", "qty": 2 },',
    '      { "name": "Latte (Large)", "qty": 1 }',
    "    ]",
    "  }",
    "}",
    "```",
    "",
    "## Placeholders",
    "",
    "| Placeholder | Prints |",
    "| --- | --- |",
    "| `{{order.id}}` | Order number in the header |",
    "| `{{store.name}}`, `{{store.address}}` | The From block |",
    "| `{{customer.name}}`, `{{customer.address}}` | The To block, first lines |",
    "| `{{customer.city}}`, `{{customer.zip}}`, `{{customer.country}}` | The To block, city line and country |",
    "| `{{#each order.items}}` with `{{name}}` and `{{qty}}` | One entry per item in Contents |",
    '| `{{barcode "code128" order.tracking}}` | The tracking barcode |',
    "| `{{order.tracking}}` | The tracking number under the barcode |",
    "",
    "## Printer requirements",
    "",
    "- Paper: 102 × 152 mm (4 × 6 in), portrait",
    "- Language: PDF on any printer; raster for thermal label printers",
    "- Margins: none. The template sets `@page { margin: 0 }`, so turn off any printer-side margin or scaling",
    "- Colour: black and white is enough. Grayscale printing keeps the barcode crisp",
    "",
    "## Changelog",
    "",
    "- v1 — initial version",
    "",
  ].join("\n");
}

export const DEFAULT_MOCK_DATA = {
  store: {
    name: "PrintNinja Cafe",
    address: "123 Main Street, Dhaka",
    email: "hello@printninja.app",
  },
  customer: {
    name: "John Doe",
    address: "45 Oak Lane, Apt 2",
    city: "Gulshan",
    zip: "1212",
    country: "Bangladesh",
    email: "john@example.com",
  },
  order: {
    id: "1042",
    date: "Oct 17, 2026",
    due: "Nov 16, 2026",
    customer: "Walk-in",
    cashier: "Aisha",
    terminal: "T1",
    tracking: "PN-7X9K-4242-BD",
    items: [
      { name: "Green Tea (Medium)", qty: 2, price: 3.5, total: 7.0 },
      { name: "Latte (Large)", qty: 1, price: 4.5, total: 4.5 },
      { name: "Croissant (Butter)", qty: 1, price: 3.0, total: 3.0 },
      { name: "Blueberry Muffin", qty: 2, price: 3.25, total: 6.5 },
    ],
    subtotal: 21.0,
    tax: 2.1,
    discount: 1.5,
    total: 21.6,
    payment: {
      method: "Credit Card",
      ref: "VISA ···· 4242",
    },
  },
};

// Nothing is seeded on first run: the Designer opens with a template list
// that is genuinely empty until the person makes one. A new template starts
// from this bundled example, so there is always real content to learn from.
export const NEW_TEMPLATE_PAGE_W_MM = 102;
export const NEW_TEMPLATE_PAGE_H_MM = 152;

/** The starting content of a newly created template: the bundled shipping
 * label example at thermal-paper size, with a README to edit down. */
export function newTemplateContent(name: string) {
  return {
    page_w_mm: NEW_TEMPLATE_PAGE_W_MM,
    page_h_mm: NEW_TEMPLATE_PAGE_H_MM,
    html: DEFAULT_TEMPLATE_HTML,
    css: DEFAULT_TEMPLATE_CSS,
    readme: defaultTemplateReadme(name),
  };
}
