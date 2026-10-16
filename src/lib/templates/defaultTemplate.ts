export const DEFAULT_TEMPLATE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
</head>
<body class="p-6 text-sm font-sans">
  <div class="flex justify-between items-center mb-4">
    <h1 class="text-lg font-bold">{{store.name}}</h1>
    <span class="text-gray-500">#{{order.id}}</span>
  </div>

  <div class="mb-4">
    <p class="text-gray-600">{{order.date}}</p>
    <p class="text-gray-600">Customer: {{order.customer}}</p>
  </div>

  <table class="w-full mb-4">
    <thead>
      <tr class="border-b-2 border-gray-300">
        <th class="text-left py-1">Item</th>
        <th class="text-right py-1">Qty</th>
        <th class="text-right py-1">Price</th>
        <th class="text-right py-1">Total</th>
      </tr>
    </thead>
    <tbody>
      {{#each order.items}}
      <tr class="border-b border-gray-100">
        <td class="py-1">{{name}}</td>
        <td class="text-right py-1">{{qty}}</td>
        <td class="text-right py-1">{{currency price}}</td>
        <td class="text-right py-1">{{currency total}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>

  <div class="flex justify-end">
    <div class="text-right">
      <p class="text-gray-600">Subtotal: {{currency order.subtotal}}</p>
      <p class="text-gray-600">Tax: {{currency order.tax}}</p>
      <p class="text-lg font-bold">Total: {{currency order.total}}</p>
    </div>
  </div>

  <div class="mt-6 text-center text-gray-400 text-xs">
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
