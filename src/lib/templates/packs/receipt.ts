export const RECEIPT_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body class="p-3 text-xs font-mono bg-white">
  <div class="text-center border-b border-dashed border-slate-400 pb-3 mb-3">
    <p class="text-sm font-bold tracking-widest uppercase">{{store.name}}</p>
    <p class="text-[10px] text-slate-500">{{store.address}}</p>
    <p class="text-[10px] text-slate-500">{{store.phone}}</p>
  </div>

  <div class="flex justify-between text-[10px] text-slate-600 mb-2">
    <span>Order #{{order.id}}</span>
    <span>{{order.date}}</span>
  </div>
  <div class="flex justify-between text-[10px] text-slate-600 mb-3">
    <span>Cashier: {{order.cashier}}</span>
    <span>Terminal: {{order.terminal}}</span>
  </div>

  <table class="w-full text-[11px] mb-3">
    <thead>
      <tr class="border-y border-slate-300">
        <th class="text-left py-1 font-semibold">Item</th>
        <th class="text-center py-1 font-semibold">Qty</th>
        <th class="text-right py-1 font-semibold">Price</th>
        <th class="text-right py-1 font-semibold">Total</th>
      </tr>
    </thead>
    <tbody>
      {{#each order.items}}
      <tr class="border-b border-dotted border-slate-200">
        <td class="py-1.5 pr-1">{{name}}</td>
        <td class="py-1.5 text-center">{{qty}}</td>
        <td class="py-1.5 text-right">{{currency price}}</td>
        <td class="py-1.5 text-right font-medium">{{currency total}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>

  <div class="space-y-1 text-[11px] mb-3">
    <div class="flex justify-between">
      <span class="text-slate-600">Subtotal</span>
      <span>{{currency order.subtotal}}</span>
    </div>
    {{#if order.discount}}
    <div class="flex justify-between text-emerald-600">
      <span>Discount</span>
      <span>-{{currency order.discount}}</span>
    </div>
    {{/if}}
    <div class="flex justify-between">
      <span class="text-slate-600">Tax</span>
      <span>{{currency order.tax}}</span>
    </div>
    <div class="flex justify-between text-sm font-bold border-t border-slate-800 pt-2">
      <span>Total</span>
      <span>{{currency order.total}}</span>
    </div>
  </div>

  <div class="border-t border-dashed border-slate-300 pt-2 mb-3 text-center">
    <p class="text-[10px] text-slate-600">Payment: {{order.payment.method}}</p>
    <p class="text-[10px] font-mono text-slate-500">{{order.payment.ref}}</p>
    {{#if order.tracking}}
    <div class="mt-2">
      {{barcode "code128" order.tracking width=60 text=false}}
      <p class="font-mono text-[10px] tracking-widest">{{order.tracking}}</p>
    </div>
    {{/if}}
  </div>

  <div class="text-center text-[10px] text-slate-400">
    <p>Thank you for your purchase!</p>
    <p>Visit us again at {{store.name}}</p>
  </div>
</body>
</html>`;

export const RECEIPT_CSS = `@page { margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`;

export function receiptReadme(name: string): string {
  return [
    `# ${name}`,
    "",
    "An 80 mm thermal receipt: store header, items table with quantities and prices, subtotal / tax / total and payment footer.",
    "",
    "## What it prints",
    "",
    "- Store header with name, address and phone.",
    "- Order meta: number, date, cashier and terminal.",
    "- **Items** table — one row per entry in `order.items`.",
    "- Totals: subtotal, optional discount, tax and grand total.",
    "- Payment line and an optional Code 128 barcode for the tracking number.",
    "- Footer thank-you line.",
    "",
    "## Data contract",
    "",
    "Send JSON shaped like this. Every key is read as text; `order.items` is a list.",
    "",
    "```json",
    "{",
    '  "store": { "name": "PrintNinja Cafe", "address": "123 Main Street, Dhaka", "phone": "+880 1700 000000" },',
    '  "order": {',
    '    "id": "1042",',
    '    "date": "Oct 17, 2026",',
    '    "cashier": "Aisha",',
    '    "terminal": "T1",',
    '    "tracking": "PN-7X9K-4242-BD",',
    '    "items": [',
    '      { "name": "Green Tea (Medium)", "qty": 2, "price": 3.5, "total": 7.0 },',
    '      { "name": "Latte (Large)", "qty": 1, "price": 4.5, "total": 4.5 }',
    "    ],",
    '    "subtotal": 11.5,',
    '    "tax": 1.15,',
    '    "discount": 0,',
    '    "total": 12.65,',
    '    "payment": { "method": "Cash", "ref": "" }',
    "  }",
    "}",
    "```",
    "",
    "## Placeholders",
    "",
    "| Placeholder | Prints |",
    "| --- | --- |",
    "| `{{store.name}}`, `{{store.address}}`, `{{store.phone}}` | Store header |",
    "| `{{order.id}}`, `{{order.date}}` | Order number and date |",
    "| `{{order.cashier}}`, `{{order.terminal}}` | Cashier and terminal |",
    "| `{{#each order.items}}` with `{{name}}`, `{{qty}}`, `{{currency price}}`, `{{currency total}}` | One row per item |",
    "| `{{currency order.subtotal}}`, `{{currency order.tax}}`, `{{currency order.total}}` | Totals |",
    "| `{{order.discount}}` | Discount line (shown only when present) |",
    "| `{{order.payment.method}}`, `{{order.payment.ref}}` | Payment info |",
    '| `{{barcode "code128" order.tracking}}` | Tracking barcode (when tracking is present) |',
    "| `{{order.tracking}}` | Tracking number under the barcode |",
    "",
    "## Printer requirements",
    "",
    "- Paper: 80 × 200 mm roll, portrait",
    "- Language: PDF on any printer; ESC/POS or raster for thermal receipt printers",
    "- Margins: none. The template sets `@page { margin: 0 }`",
    "- Colour: black and white is enough",
    "",
    "## Changelog",
    "",
    "- v1 — initial version",
    "",
  ].join("\n");
}

export const RECEIPT_MOCK_DATA = {
  store: {
    name: "PrintNinja Cafe",
    address: "123 Main Street, Dhaka",
    phone: "+880 1700 000000",
    email: "hello@printninja.app",
  },
  order: {
    id: "1042",
    date: "Oct 17, 2026",
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

export const RECEIPT_PACK = {
  id: "receipt",
  name: "Receipt",
  description: "80 mm receipt with items, totals and payment",
  page_w_mm: 80,
  page_h_mm: 200,
  html: RECEIPT_HTML,
  css: RECEIPT_CSS,
  readme: receiptReadme,
  mockData: RECEIPT_MOCK_DATA,
} as const;
