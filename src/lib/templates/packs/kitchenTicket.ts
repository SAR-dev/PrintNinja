export const KITCHEN_TICKET_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body class="p-3 text-xs font-mono bg-white">
  <div class="border-2 border-slate-900 rounded p-2 mb-3 text-center">
    <p class="text-[10px] uppercase tracking-widest text-slate-500">Kitchen Ticket</p>
    <p class="text-3xl font-black tracking-tight">#{{ticket.number}}</p>
    <div class="flex justify-center gap-3 text-[10px] text-slate-600 mt-1">
      <span>Table {{ticket.table}}</span>
      <span>·</span>
      <span>{{ticket.createdAt}}</span>
    </div>
  </div>

  {{#if ticket.customer}}
  <p class="text-[11px] text-center text-slate-700 mb-2">For: <strong>{{ticket.customer}}</strong></p>
  {{/if}}

  <div class="space-y-2 mb-3">
    {{#each ticket.items}}
    <div class="border-b border-dotted border-slate-300 pb-2 last:border-0">
      <div class="flex justify-between items-start">
        <span class="text-sm font-bold">{{qty}}× {{name}}</span>
        {{#if mods}}
        <span class="text-[10px] text-slate-500 ml-2 shrink-0">mods</span>
        {{/if}}
      </div>
      {{#if mods}}
      <ul class="ml-4 mt-1 space-y-0.5">
        {{#each mods}}
        <li class="text-[10px] text-slate-600">+ {{this}}</li>
        {{/each}}
      </ul>
      {{/if}}
      {{#if note}}
      <p class="text-[11px] text-amber-700 bg-amber-50 rounded px-1.5 py-0.5 mt-1">⚠ {{note}}</p>
      {{/if}}
    </div>
    {{/each}}
  </div>

  {{#if ticket.notes}}
  <div class="bg-slate-900 text-white rounded p-2 mb-3">
    <p class="text-[10px] uppercase tracking-widest text-slate-400">Notes</p>
    <p class="text-[11px] font-medium">{{ticket.notes}}</p>
  </div>
  {{/if}}

  <div class="text-center border-t-2 border-slate-900 pt-2">
    <p class="text-[10px] text-slate-500">{{ticket.createdAt}}</p>
    {{#if ticket.cashier}}<p class="text-[10px] text-slate-400">By {{ticket.cashier}}</p>{{/if}}
  </div>
</body>
</html>`;

export const KITCHEN_TICKET_CSS = `@page { margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`;

export function kitchenTicketReadme(name: string): string {
  return [
    `# ${name}`,
    "",
    "An 80 mm kitchen ticket: large order number, items with modifiers and notes, and a timestamp — made for the pass.",
    "",
    "## What it prints",
    "",
    "- Big ticket number, table and timestamp header.",
    "- Items: quantity × name, with optional modifier list and per-item note.",
    "- Kitchen notes block when `ticket.notes` is present.",
    "- Footer timestamp and cashier.",
    "",
    "## Data contract",
    "",
    "Send JSON shaped like this. Every key is read as text; `ticket.items` is a list.",
    "",
    "```json",
    "{",
    '  "ticket": {',
    '    "number": "42",',
    '    "table": "A3",',
    '    "customer": "John",',
    '    "createdAt": "Oct 17, 2026 14:32",',
    '    "cashier": "Aisha",',
    '    "notes": "Allergy: no peanuts",',
    '    "items": [',
    '      { "name": "Green Tea (Medium)", "qty": 2, "mods": ["Less sugar"], "note": "" },',
    '      { "name": "Latte (Large)", "qty": 1, "mods": ["Oat milk", "Extra shot"], "note": "Hot" }',
    "    ]",
    "  }",
    "}",
    "```",
    "",
    "## Placeholders",
    "",
    "| Placeholder | Prints |",
    "| --- | --- |",
    "| `{{ticket.number}}` | Large ticket number |",
    "| `{{ticket.table}}`, `{{ticket.createdAt}}`, `{{ticket.cashier}}` | Header meta |",
    "| `{{ticket.customer}}` | Customer name (when present) |",
    "| `{{#each ticket.items}}` with `{{qty}}`, `{{name}}`, `{{#each mods}}` | One block per item with modifiers |",
    "| `{{note}}` (inside items) | Per-item warning line |",
    "| `{{ticket.notes}}` | Kitchen notes block |",
    "",
    "## Printer requirements",
    "",
    "- Paper: 80 × 150 mm roll, portrait",
    "- Language: PDF on any printer; ESC/POS or raster for kitchen thermal printers",
    "- Margins: none. The template sets `@page { margin: 0 }`",
    "- Colour: black and white is enough; the amber note survives grayscale",
    "",
    "## Changelog",
    "",
    "- v1 — initial version",
    "",
  ].join("\n");
}

export const KITCHEN_TICKET_MOCK_DATA = {
  ticket: {
    number: "42",
    table: "A3",
    customer: "John",
    createdAt: "Oct 17, 2026 14:32",
    cashier: "Aisha",
    notes: "Allergy: no peanuts",
    items: [
      { name: "Green Tea (Medium)", qty: 2, mods: ["Less sugar"], note: "" },
      {
        name: "Latte (Large)",
        qty: 1,
        mods: ["Oat milk", "Extra shot"],
        note: "Extra hot",
      },
      { name: "Croissant (Butter)", qty: 2, mods: [], note: "" },
      { name: "Blueberry Muffin", qty: 1, mods: [], note: "No nuts" },
    ],
  },
};

export const KITCHEN_TICKET_PACK = {
  id: "kitchenTicket",
  name: "Kitchen Ticket",
  description: "80 mm kitchen ticket with modifiers and notes",
  page_w_mm: 80,
  page_h_mm: 150,
  html: KITCHEN_TICKET_HTML,
  css: KITCHEN_TICKET_CSS,
  readme: kitchenTicketReadme,
  mockData: KITCHEN_TICKET_MOCK_DATA,
} as const;
