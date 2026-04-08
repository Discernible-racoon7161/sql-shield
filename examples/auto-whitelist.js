// Example: Auto-generate a whitelist from your PostgreSQL database.
// Requires: npm install pg

import { generateWhitelist } from 'sql-shield/catalog';
import { validateSQL } from 'sql-shield';

// --- Step 1: Generate whitelist from your database schema ---
const whitelist = await generateWhitelist({
  host: 'localhost',
  port: 5432,
  database: 'my_shop',
  schema: 'public',
  user: 'readonly_user',
  password: process.env.DB_PASSWORD,
  // Exclude internal tables
  excludeTables: ['migrations', 'sessions', 'admin_users', 'schema_version'],
});

console.log('Discovered tables:', whitelist.tables);
console.log('Columns per table:', Object.keys(whitelist.columns).length, 'tables');

// --- Step 2: Use the whitelist for validation ---
const result = validateSQL('SELECT name, email FROM customers', {
  allowedTables: whitelist.tables,
  allowedColumns: whitelist.columns,
  maxRows: 200,
});

if (result.safe) {
  console.log('Query is safe:', result.sql);
} else {
  console.log('Query blocked:', result.violations);
}
