export const DEFAULT_TEMPLATE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
</head>
<body class="p-8 text-sm font-sans">
  <div class="flex justify-between items-center pb-4 border-b border-gray-200 mb-4">
    <h1 class="text-xl font-bold">{{store.name}}</h1>
    <span class="text-gray-500 font-mono">#{{order.id}}</span>
  </div>

  <div class="space-y-1 mb-4 px-2 py-2 rounded bg-gray-50">
    <p class="text-gray-600">{{order.date}}</p>
    <p class="text-gray-600">Customer: {{order.customer}}</p>
  </div>

  <table class="w-full mb-4">
    <thead>
      <tr class="border-b-2 border-gray-300">
        <th class="text-left py-2 px-2">Item</th>
        <th class="text-right py-2 px-2">Qty</th>
        <th class="text-right py-2 px-2">Price</th>
        <th class="text-right py-2 px-2">Total</th>
      </tr>
    </thead>
    <tbody>
      {{#each order.items}}
      <tr class="border-b border-gray-100">
        <td class="py-2 px-2">{{name}}</td>
        <td class="text-right py-2 px-2">{{qty}}</td>
        <td class="text-right py-2 px-2">{{currency price}}</td>
        <td class="text-right py-2 px-2">{{currency total}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>

  <div class="flex justify-end px-2">
    <div class="text-right space-y-1">
      <p class="text-gray-600">Subtotal: {{currency order.subtotal}}</p>
      <p class="text-gray-600">Tax: {{currency order.tax}}</p>
      <div class="border-t border-gray-300 pt-2">
        <p class="text-lg font-bold">Total: {{currency order.total}}</p>
      </div>
    </div>
  </div>

  <div class="mt-8 pt-4 border-t border-gray-200 text-center text-gray-400 text-xs">
    <p>Thank you for your business!</p>
  </div>
</body>
</html>`;

export const DEFAULT_TEMPLATE_CSS = `@page {
  size: 80mm 200mm;
  margin: 5mm;
}

body {
  font-family: 'Noto Sans', sans-serif;
  color: #1a1a1a;
  line-height: 1.4;
}

table {
  border-collapse: collapse;
}

th, td {
  padding: 2px 4px;
}`;

export const DEFAULT_MOCK_DATA = {
  store: {
    name: "PrintNinja Cafe",
    address: "123 Main Street",
  },
  order: {
    id: "1042",
    date: "2026-10-17",
    customer: "Walk-in",
    items: [
      { name: "Green Tea", qty: 2, price: 3.5, total: 7.0 },
      { name: "Latte", qty: 1, price: 4.5, total: 4.5 },
      { name: "Croissant", qty: 1, price: 3.0, total: 3.0 },
    ],
    subtotal: 14.5,
    tax: 1.45,
    total: 15.95,
  },
};
