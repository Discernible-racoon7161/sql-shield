// Example: OpenAI → sql-shield → PostgreSQL
// Shows the full pipeline: LLM generates SQL, sql-shield validates, then execute.

import { validateSQL, fixupSQL, toPositionalParams } from 'sql-shield';
// import { generateWhitelist } from 'sql-shield/catalog';
// import OpenAI from 'openai';
// import pg from 'pg';

// --- Step 1: Define your whitelist ---
// In production, use generateWhitelist() to auto-discover from your DB.
const whitelist = {
  tables: ['customers', 'orders', 'products'],
  columns: {
    customers: ['customer_id', 'name', 'region', 'segment'],
    orders: ['order_id', 'customer_id', 'order_date', 'total'],
    products: ['product_id', 'name', 'category', 'price'],
  },
};

// --- Step 2: LLM generates SQL ---
// const openai = new OpenAI();
// const completion = await openai.chat.completions.create({
//   model: 'gpt-4.1-mini',
//   messages: [{
//     role: 'system',
//     content: `Generate PostgreSQL SELECT queries. Available tables: ${whitelist.tables.join(', ')}. Use :b1, :b2 for bind variables.`,
//   }, {
//     role: 'user',
//     content: 'Show me top 10 customers by total order value',
//   }],
// });
// const rawSQL = completion.choices[0].message.content;

// Simulated LLM output:
const rawSQL = `
  SELECT c.name, SUM(o.total) AS total_revenue
  FROM custmers c
  JOIN orders o ON o.customer_id = c.customer_id
  GROUP BY c.name
  ORDER BY total_revenue DESC;
`;

// --- Step 3: sql-shield fixes LLM mistakes ---
const fixed = fixupSQL(rawSQL, {
  knownTables: whitelist.tables,
  knownColumns: whitelist.columns,
});

console.log('Fixed SQL:', fixed.sql);
console.log('Corrections:', fixed.corrections);

// --- Step 4: sql-shield validates against policy ---
const validation = validateSQL(fixed.sql, {
  allowedTables: whitelist.tables,
  allowedColumns: whitelist.columns,
  maxRows: 100,
});

if (!validation.safe) {
  console.error('SQL rejected:', validation.violations);
  process.exit(1);
}

console.log('Validated SQL:', validation.sql);

// --- Step 5: Convert binds and execute ---
// const { sql, values } = toPositionalParams(validation.sql, binds);
// const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// const result = await pool.query(sql, values);
// console.log('Results:', result.rows);
