export const INVOICE_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body class="p-6 text-xs font-sans text-slate-800">
  <div class="flex justify-between items-start border-b-2 border-slate-800 pb-4 mb-4">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">INVOICE</h1>
      <p class="text-[11px] text-slate-500 mt-1">No. {{invoice.number}} · {{invoice.date}}</p>
      {{#if invoice.due}}<p class="text-[10px] text-amber-600">Due: {{invoice.due}}</p>{{/if}}
    </div>
    <div class="text-right">
      <p class="text-sm font-bold">{{seller.name}}</p>
      <p class="text-[10px] text-slate-600">{{seller.address}}</p>
      <p class="text-[10px] text-slate-600">{{seller.email}}</p>
      <p class="text-[10px] text-slate-600">{{seller.phone}}</p>
    </div>
  </div>

  <div class="grid grid-cols-2 gap-6 mb-6">
    <div>
      <p class="text-[9px] uppercase tracking-widest font-semibold text-slate-500 mb-1">Bill to</p>
      <p class="text-[12px] font-semibold">{{buyer.name}}</p>
      <p class="text-[11px] text-slate-600">{{buyer.address}}</p>
      <p class="text-[10px] text-slate-500">{{buyer.email}}</p>
    </div>
    <div class="text-right">
      <p class="text-[9px] uppercase tracking-widest font-semibold text-slate-500 mb-1">Payment</p>
      <p class="text-[11px]">{{invoice.payment.method}}</p>
      <p class="text-[10px] font-mono text-slate-600">{{invoice.payment.ref}}</p>
      {{#if invoice.tracking}}
      <div class="mt-2">
        {{barcode "code128" invoice.tracking width=50 text=false}}
        <p class="font-mono text-[9px] tracking-widest">{{invoice.tracking}}</p>
      </div>
      {{/if}}
    </div>
  </div>

  <table class="w-full text-[11px] mb-4">
    <thead>
      <tr class="bg-slate-800 text-white">
        <th class="text-left py-2 px-2 font-semibold">#</th>
        <th class="text-left py-2 px-2 font-semibold">Description</th>
        <th class="text-center py-2 px-2 font-semibold">Qty</th>
        <th class="text-right py-2 px-2 font-semibold">Unit</th>
        <th class="text-right py-2 px-2 font-semibold">Amount</th>
      </tr>
    </thead>
    <tbody>
      {{#each invoice.items}}
      <tr class="border-b border-slate-200">
        <td class="py-2 px-2 text-slate-500">{{@index}}</td>
        <td class="py-2 px-2">{{name}}</td>
        <td class="py-2 px-2 text-center">{{qty}}</td>
        <td class="py-2 px-2 text-right">{{currency price}}</td>
        <td class="py-2 px-2 text-right font-medium">{{currency total}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>

  <div class="flex justify-end mb-6">
    <div class="w-56 space-y-1 text-[11px]">
      <div class="flex justify-between">
        <span class="text-slate-600">Subtotal</span>
        <span>{{currency invoice.subtotal}}</span>
      </div>
      {{#if invoice.discount}}
      <div class="flex justify-between text-emerald-600">
        <span>Discount</span>
        <span>-{{currency invoice.discount}}</span>
      </div>
      {{/if}}
      <div class="flex justify-between">
        <span class="text-slate-600">Tax</span>
        <span>{{currency invoice.tax}}</span>
      </div>
      <div class="flex justify-between text-sm font-bold border-t-2 border-slate-800 pt-2">
        <span>Total</span>
        <span>{{currency invoice.total}}</span>
      </div>
    </div>
  </div>

  {{#if invoice.notes}}
  <div class="border-t border-slate-200 pt-3">
    <p class="text-[9px] uppercase tracking-widest font-semibold text-slate-500 mb-1">Notes</p>
    <p class="text-[11px] text-slate-600">{{invoice.notes}}</p>
  </div>
  {{/if}}

  <div class="text-center text-[9px] text-slate-400 mt-6 border-t border-dashed pt-3">
    <p>Thank you for your business!</p>
  </div>
</body>
</html>`;

export const INVOICE_CSS = `@page { margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`;

export function invoiceReadme(name: string): string {
  return [
    `# ${name}`,
    "",
    "An A4 invoice: seller and buyer blocks, line-item table with totals, due date and payment reference.",
    "",
    "## What it prints",
    "",
    "- Header with invoice number, date, due date and seller info.",
    "- **Bill to** buyer block and payment method.",
    "- Line-item table from `invoice.items`.",
    "- Totals: subtotal, optional discount, tax and total.",
    "- Optional notes and tracking barcode.",
    "",
    "## Data contract",
    "",
    "Send JSON shaped like this. Every key is read as text; `invoice.items` is a list.",
    "",
    "```json",
    "{",
    '  "seller": { "name": "PrintNinja Ltd", "address": "123 Main Street, Dhaka", "email": "hello@printninja.app", "phone": "+880 1700 000000" },',
    '  "buyer": { "name": "Acme Corp", "address": "45 Business Ave, Gulshan", "email": "accounts@acme.example" },',
    '  "invoice": {',
    '    "number": "INV-1042",',
    '    "date": "Oct 17, 2026",',
    '    "due": "Nov 16, 2026",',
    '    "tracking": "PN-7X9K-4242-BD",',
    '    "items": [',
    '      { "name": "Green Tea (Medium)", "qty": 2, "price": 3.5, "total": 7.0 },',
    '      { "name": "Latte (Large)", "qty": 1, "price": 4.5, "total": 4.5 }',
    "    ],",
    '    "subtotal": 11.5,',
    '    "tax": 1.15,',
    '    "discount": 0,',
    '    "total": 12.65,',
    '    "notes": "Payment due within 30 days.",',
    '    "payment": { "method": "Bank Transfer", "ref": "INV-1042" }',
    "  }",
    "}",
    "```",
    "",
    "## Placeholders",
    "",
    "| Placeholder | Prints |",
    "| --- | --- |",
    "| `{{invoice.number}}`, `{{invoice.date}}`, `{{invoice.due}}` | Header invoice meta |",
    "| `{{seller.name}}`, `{{seller.address}}`, `{{seller.email}}`, `{{seller.phone}}` | Seller block |",
    "| `{{buyer.name}}`, `{{buyer.address}}`, `{{buyer.email}}` | Buyer block |",
    "| `{{#each invoice.items}}` with `{{name}}`, `{{qty}}`, `{{currency price}}`, `{{currency total}}` | One row per line item |",
    "| `{{currency invoice.subtotal}}`, `{{currency invoice.tax}}`, `{{currency invoice.total}}` | Totals |",
    "| `{{invoice.discount}}` | Discount line (when present) |",
    "| `{{invoice.notes}}` | Notes section |",
    "| `{{invoice.payment.method}}`, `{{invoice.payment.ref}}` | Payment info |",
    '| `{{barcode "code128" invoice.tracking}}` | Tracking barcode |',
    "| `{{invoice.tracking}}` | Tracking number under the barcode |",
    "",
    "## Printer requirements",
    "",
    "- Paper: 210 × 297 mm (A4), portrait",
    "- Language: PDF",
    "- Margins: none. The template sets `@page { margin: 0 }`",
    "- Colour: works in black and white or colour",
    "",
    "## Changelog",
    "",
    "- v1 — initial version",
    "",
  ].join("\n");
}

export const INVOICE_MOCK_DATA = {
  seller: {
    name: "PrintNinja Ltd",
    address: "123 Main Street, Dhaka",
    email: "hello@printninja.app",
    phone: "+880 1700 000000",
  },
  buyer: {
    name: "Acme Corp",
    address: "45 Business Ave, Gulshan",
    email: "accounts@acme.example",
    phone: "+880 1900 000002",
  },
  invoice: {
    number: "INV-1042",
    date: "Oct 17, 2026",
    due: "Nov 16, 2026",
    tracking: "PN-7X9K-4242-BD",
    items: [
      { name: "Green Tea (Medium)", qty: 2, price: 3.5, total: 7.0 },
      { name: "Latte (Large)", qty: 1, price: 4.5, total: 4.5 },
      { name: "Croissant (Butter)", qty: 3, price: 3.0, total: 9.0 },
      { name: "Blueberry Muffin", qty: 2, price: 3.25, total: 6.5 },
    ],
    subtotal: 27.0,
    tax: 2.7,
    discount: 2.0,
    total: 27.7,
    notes: "Payment due within 30 days. Thank you for your business!",
    payment: {
      method: "Bank Transfer",
      ref: "INV-1042 · A/C ···· 4242",
    },
  },
};

export const INVOICE_PACK = {
  id: "invoice",
  name: "Invoice",
  description: "A4 invoice with seller, buyer and line totals",
  page_w_mm: 210,
  page_h_mm: 297,
  html: INVOICE_HTML,
  css: INVOICE_CSS,
  readme: invoiceReadme,
  mockData: INVOICE_MOCK_DATA,
} as const;
