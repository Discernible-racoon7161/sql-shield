// Basic example: validate a single SQL query against a whitelist.

import { validateSQL, fixupSQL } from 'sql-shield';

// Define your security policy
const policy = {
  allowedTables: ['customers', 'orders', 'products'],
  allowedColumns: {
    customers: ['customer_id', 'name', 'region', 'segment'],
    orders: ['order_id', 'customer_id', 'order_date', 'total'],
    products: ['product_id', 'name', 'category', 'price'],
  },
  maxRows: 100,
};

// --- Example 1: Safe query ---
const safe = validateSQL(
  'SELECT c.name, c.region FROM customers c WHERE c.segment = :b1',
  policy,
);
console.log('Safe query:', safe);
// { safe: true, sql: "SELECT c.name, c.region FROM customers c WHERE c.segment = :b1 LIMIT 100", violations: [] }

// --- Example 2: Blocked column ---
const blocked = validateSQL(
  "SELECT c.name, c.email FROM customers c WHERE c.region = 'EU'",
  policy,
);
console.log('Blocked column:', blocked);
// { safe: false, sql: null, violations: [{ type: 'COLUMN_NOT_ALLOWED', table: 'CUSTOMERS', column: 'EMAIL' }] }

// --- Example 3: Fix + validate pipeline ---
const badSQL = 'SELECT COUNT(orders) FROM custmers;';

const fixed = fixupSQL(badSQL, {
  knownTables: policy.allowedTables,
  knownColumns: policy.allowedColumns,
});
console.log('Fixed SQL:', fixed.sql);
console.log('Corrections:', fixed.corrections);

const validated = validateSQL(fixed.sql, policy);
console.log('Validated:', validated);
