export const DELIVERY_SLIP_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body class="p-4 text-xs font-sans">
  <div class="flex flex-col h-full justify-between">
    <div class="space-y-3">
      <div class="flex justify-between items-start border-b-2 border-slate-800 pb-2">
        <div>
          <p class="text-sm font-bold tracking-widest uppercase">Delivery Slip</p>
          <p class="text-[10px] text-slate-500">Order #{{order.id}} · {{order.date}}</p>
        </div>
        <div class="text-right">
          <p class="text-[10px] font-semibold text-slate-700">{{store.name}}</p>
          <p class="text-[10px] text-slate-500">{{store.phone}}</p>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="border border-slate-200 rounded p-2">
          <p class="text-[9px] uppercase tracking-wider font-semibold text-slate-500 mb-1">From</p>
          <p class="text-[11px] font-medium">{{store.name}}</p>
          <p class="text-[10px] text-slate-600">{{store.address}}</p>
          <p class="text-[10px] text-slate-600">{{store.phone}}</p>
        </div>
        <div class="border border-slate-800 rounded p-2 bg-slate-50">
          <p class="text-[9px] uppercase tracking-wider font-semibold text-slate-500 mb-1">Deliver to</p>
          <p class="text-[11px] font-bold">{{customer.name}}</p>
          <p class="text-[10px] text-slate-700">{{customer.address}}</p>
          <p class="text-[10px] text-slate-700">{{customer.city}} {{customer.zip}}</p>
          <p class="text-[10px] text-slate-700">{{customer.phone}}</p>
        </div>
      </div>

      <div class="border border-slate-200 rounded p-2">
        <p class="text-[9px] uppercase tracking-wider font-semibold text-slate-500 mb-1">Contents</p>
        <ul class="space-y-1">
          {{#each order.items}}
          <li class="flex justify-between text-[11px]">
            <span>{{name}}</span>
            <span class="font-mono text-slate-600">×{{qty}}</span>
          </li>
          {{/each}}
        </ul>
        {{#if order.notes}}
        <p class="text-[10px] text-slate-500 mt-2 border-t border-dotted pt-1">Note: {{order.notes}}</p>
        {{/if}}
      </div>

      {{#if order.courier}}
      <div class="flex justify-between text-[10px] text-slate-600 bg-amber-50 rounded p-2">
        <span>Courier: <strong>{{order.courier}}</strong></span>
        <span>COD: <strong>{{currency order.total}}</strong></span>
      </div>
      {{/if}}
    </div>

    <div class="border-t-2 border-slate-800 pt-3 text-center mt-3">
      {{barcode "code128" order.tracking width=70 text=false}}
      <p class="font-mono text-sm font-bold tracking-widest">{{order.tracking}}</p>
      <p class="text-[9px] text-slate-400">Tracking · Scan on delivery</p>
    </div>
  </div>
</body>
</html>`;

export const DELIVERY_SLIP_CSS = `@page { margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`;

export function deliverySlipReadme(name: string): string {
  return [
    `# ${name}`,
    "",
    "A courier delivery slip: From/To address blocks, contents list with quantities, optional courier and COD, and a Code 128 tracking barcode.",
    "",
    "## What it prints",
    "",
    "- Header with the order number, date and store name.",
    "- **From** and **Deliver to** address blocks.",
    "- **Contents** — a list of `order.items` with quantities and an optional note.",
    "- Courier and COD line when `order.courier` is present.",
    "- Code 128 tracking barcode with number below.",
    "",
    "## Data contract",
    "",
    "Send JSON shaped like this. Every key is read as text; `order.items` is a list.",
    "",
    "```json",
    "{",
    '  "store": { "name": "PrintNinja Cafe", "address": "123 Main Street, Dhaka", "phone": "+880 1700 000000" },',
    '  "customer": { "name": "John Doe", "address": "45 Oak Lane, Apt 2", "city": "Gulshan", "zip": "1212", "phone": "+880 1800 000001" },',
    '  "order": { "id": "1042", "date": "Oct 17, 2026", "tracking": "PN-7X9K-4242-BD", "courier": "Pathao", "total": 21.6, "notes": "Leave at door",',
    '    "items": [ { "name": "Green Tea (Medium)", "qty": 2 }, { "name": "Latte (Large)", "qty": 1 } ] }',
    "}",
    "```",
    "",
    "## Placeholders",
    "",
    "| Placeholder | Prints |",
    "| --- | --- |",
    "| `{{order.id}}`, `{{order.date}}` | Header order number and date |",
    "| `{{store.name}}`, `{{store.address}}`, `{{store.phone}}` | From block |",
    "| `{{customer.name}}`, `{{customer.address}}`, `{{customer.city}}`, `{{customer.zip}}`, `{{customer.phone}}` | Deliver-to block |",
    "| `{{#each order.items}}` with `{{name}}`, `{{qty}}` | One line per item |",
    "| `{{order.notes}}` | Optional delivery note |",
    "| `{{order.courier}}`, `{{currency order.total}}` | Courier and COD |",
    '| `{{barcode "code128" order.tracking}}` | Tracking barcode |',
    "| `{{order.tracking}}` | Tracking number |",
    "",
    "## Printer requirements",
    "",
    "- Paper: 102 × 152 mm (4 × 6 in), portrait",
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

export const DELIVERY_SLIP_MOCK_DATA = {
  store: {
    name: "PrintNinja Cafe",
    address: "123 Main Street, Dhaka",
    phone: "+880 1700 000000",
  },
  customer: {
    name: "John Doe",
    address: "45 Oak Lane, Apt 2",
    city: "Gulshan",
    zip: "1212",
    country: "Bangladesh",
    phone: "+880 1800 000001",
  },
  order: {
    id: "1042",
    date: "Oct 17, 2026",
    tracking: "PN-7X9K-4242-BD",
    courier: "Pathao",
    notes: "Leave at door if not home",
    items: [
      { name: "Green Tea (Medium)", qty: 2 },
      { name: "Latte (Large)", qty: 1 },
      { name: "Blueberry Muffin", qty: 2 },
    ],
    total: 21.6,
  },
};

export const DELIVERY_SLIP_PACK = {
  id: "deliverySlip",
  name: "Delivery Slip",
  description: "Courier slip with From/To and tracking barcode",
  page_w_mm: 102,
  page_h_mm: 152,
  html: DELIVERY_SLIP_HTML,
  css: DELIVERY_SLIP_CSS,
  readme: deliverySlipReadme,
  mockData: DELIVERY_SLIP_MOCK_DATA,
} as const;
