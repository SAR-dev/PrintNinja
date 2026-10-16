export const DEFAULT_TEMPLATE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
</head>
<body class="bg-white text-slate-900 font-sans antialiased p-6">
  <!-- Header band -->
  <div class="border-b-2 border-slate-800 pb-6 mb-6 px-2">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-4">
        <div class="h-12 w-12 rounded-xl bg-slate-800 text-white flex items-center justify-center text-lg font-bold shrink-0">
          PN
        </div>
        <div>
          <h1 class="text-xl font-bold leading-tight">{{store.name}}</h1>
          <p class="text-xs text-slate-500 leading-tight">{{store.address}}</p>
        </div>
      </div>
      <div class="text-right">
        <p class="text-[10px] uppercase tracking-wider text-slate-500">Receipt</p>
        <p class="text-sm font-mono font-semibold">#{{order.id}}</p>
      </div>
    </div>
  </div>

  <!-- Meta info -->
  <div class="grid grid-cols-2 gap-x-4 gap-y-1 mb-4 text-xs">
    <div class="flex justify-between">
      <span class="text-slate-500">Date</span>
      <span class="font-medium">{{order.date}}</span>
    </div>
    <div class="flex justify-between">
      <span class="text-slate-500">Customer</span>
      <span class="font-medium">{{order.customer}}</span>
    </div>
    <div class="flex justify-between">
      <span class="text-slate-500">Cashier</span>
      <span class="font-medium">{{order.cashier}}</span>
    </div>
    <div class="flex justify-between">
      <span class="text-slate-500">Terminal</span>
      <span class="font-medium">{{order.terminal}}</span>
    </div>
  </div>

  <div class="border-b border-dashed border-slate-300 mb-4"></div>

  <!-- Items table -->
  <table class="w-full mb-4 text-xs">
    <thead>
      <tr class="border-b-2 border-slate-800">
        <th class="text-left py-2 font-semibold uppercase tracking-wider text-slate-700">Item</th>
        <th class="text-right py-2 font-semibold uppercase tracking-wider text-slate-700">Qty</th>
        <th class="text-right py-2 font-semibold uppercase tracking-wider text-slate-700">Price</th>
        <th class="text-right py-2 font-semibold uppercase tracking-wider text-slate-700">Total</th>
      </tr>
    </thead>
    <tbody>
      {{#each order.items}}
      <tr class="border-b border-slate-100">
        <td class="py-2 text-slate-800">{{name}}</td>
        <td class="py-2 text-right text-slate-600">{{qty}}</td>
        <td class="py-2 text-right text-slate-600">{{currency price}}</td>
        <td class="py-2 text-right font-medium">{{currency total}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>

  <!-- Totals -->
  <div class="space-y-1 text-xs border-t border-slate-200 pt-3">
    <div class="flex justify-between">
      <span class="text-slate-500">Subtotal</span>
      <span class="text-slate-700">{{currency order.subtotal}}</span>
    </div>
    <div class="flex justify-between">
      <span class="text-slate-500">Tax (10%)</span>
      <span class="text-slate-700">{{currency order.tax}}</span>
    </div>
    <div class="flex justify-between">
      <span class="text-slate-500">Discount</span>
      <span class="text-emerald-600">-{{currency order.discount}}</span>
    </div>
    <div class="flex justify-between border-t border-slate-800 pt-2 text-base">
      <span class="font-bold">Total</span>
      <span class="font-bold">{{currency order.total}}</span>
    </div>
  </div>

  <!-- Payment info -->
  <div class="mt-4 flex justify-between text-xs text-slate-500">
    <span>Paid: {{order.payment.method}}</span>
    <span>{{order.payment.ref}}</span>
  </div>

  <!-- Footer -->
  <div class="mt-6 pt-4 border-t border-dashed border-slate-300 text-center">
    <p class="text-xs text-slate-500">Thank you for your business!</p>
    <p class="text-[10px] text-slate-400 mt-1">Exchange or refund within 30 days with receipt</p>
    <p class="text-[10px] text-slate-400">PrintNinja v1.0</p>
  </div>
</body>
</html>`;

export const DEFAULT_TEMPLATE_CSS = `@page {
  margin: 4mm;
  @bottom-center { content: counter(page); }
}

* { box-sizing: border-box; }
body {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
  margin: 0;
  padding: 0;
}`;

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

// Starter templates shown in the Designer's template list
export const STARTER_TEMPLATES = [
  {
    name: "Receipt 120mm",
    page_w_mm: 120,
    page_h_mm: 200,
    orientation: "portrait" as const,
    html: DEFAULT_TEMPLATE_HTML,
    css: DEFAULT_TEMPLATE_CSS,
  },
  {
    name: "Shipping Label 4x6",
    page_w_mm: 102,
    page_h_mm: 152,
    orientation: "portrait" as const,
    html: `<!DOCTYPE html>
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
      <p class="font-mono text-base font-bold tracking-widest">{{order.tracking}}</p>
      <p class="text-[9px] text-slate-400 mt-1">Tracking number</p>
    </div>
  </div>
</body>
</html>`,
    css: `@page { margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`,
  },
  {
    name: "Invoice A4",
    page_w_mm: 210,
    page_h_mm: 297,
    orientation: "portrait" as const,
    html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body class="p-10 text-sm font-sans bg-white">
  <div class="flex justify-between items-start mb-8">
    <div>
      <h1 class="text-3xl font-bold text-slate-800">INVOICE</h1>
      <p class="text-xs text-slate-500 mt-1">Invoice #{{order.id}}</p>
    </div>
    <div class="text-right text-xs text-slate-600">
      <p class="font-semibold text-slate-800">{{store.name}}</p>
      <p>{{store.address}}</p>
      <p>{{store.email}}</p>
    </div>
  </div>

  <div class="grid grid-cols-2 gap-8 mb-6 text-xs">
    <div>
      <p class="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Bill To</p>
      <p class="text-slate-800 font-medium">{{customer.name}}</p>
      <p class="text-slate-600">{{customer.address}}</p>
      <p class="text-slate-600">{{customer.city}}, {{customer.zip}}</p>
      <p class="text-slate-600">{{customer.email}}</p>
    </div>
    <div>
      <p class="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Details</p>
      <div class="space-y-1 text-xs">
        <div class="flex justify-between"><span class="text-slate-500">Issue date</span><span>{{order.date}}</span></div>
        <div class="flex justify-between"><span class="text-slate-500">Due date</span><span>{{order.due}}</span></div>
        <div class="flex justify-between"><span class="text-slate-500">Terms</span><span>Net 30</span></div>
      </div>
    </div>
  </div>

  <table class="w-full mb-6 text-xs">
    <thead>
      <tr class="bg-slate-800 text-white">
        <th class="text-left py-2 px-3">Description</th>
        <th class="text-right py-2 px-3">Qty</th>
        <th class="text-right py-2 px-3">Unit</th>
        <th class="text-right py-2 px-3">Total</th>
      </tr>
    </thead>
    <tbody>
      {{#each order.items}}
      <tr class="border-b border-slate-200">
        <td class="py-2 px-3 text-slate-800">{{name}}</td>
        <td class="py-2 px-3 text-right text-slate-600">{{qty}}</td>
        <td class="py-2 px-3 text-right text-slate-600">{{currency price}}</td>
        <td class="py-2 px-3 text-right font-medium">{{currency total}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>

  <div class="flex justify-end">
    <div class="w-48 text-xs space-y-1">
      <div class="flex justify-between"><span class="text-slate-500">Subtotal</span><span>{{currency order.subtotal}}</span></div>
      <div class="flex justify-between"><span class="text-slate-500">Tax</span><span>{{currency order.tax}}</span></div>
      <div class="flex justify-between border-t border-slate-800 pt-2 text-base font-bold"><span>Total</span><span>{{currency order.total}}</span></div>
    </div>
  </div>

  <div class="mt-12 pt-6 border-t border-slate-200 text-xs text-slate-500">
    <p class="font-medium text-slate-700">Payment terms:</p>
    <p>Please pay within 30 days. Late payments accrue 1.5% / month.</p>
    <p class="mt-2 italic">Generated with PrintNinja.</p>
  </div>
</body>
</html>`,
    css: `@page { margin: 20mm; }
* { box-sizing: border-box; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }`,
  },
];
