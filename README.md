# sql-shield

[![CI](https://github.com/davoroh/sql-shield/actions/workflows/ci.yml/badge.svg)](https://github.com/davoroh/sql-shield/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

**SQL security middleware for LLM-generated queries.**

LLMs can generate any SQL. DROP TABLE, DELETE FROM, SELECT from tables with sensitive data. The model doesn't know your security policy. Most text-to-SQL tools run whatever the LLM produces.

sql-shield sits between your LLM and your database:

```
         ┌──────────┐     ┌────────────┐     ┌──────────┐
User ──► │ Your LLM  │ ──► │ sql-shield │ ──► │ Database │
         └──────────┘     └────────────┘     └──────────┘
                           │ validate    │
                           │ fixup       │
                           │ enforce     │
```

## What it does

- **Table whitelist** — only pre-approved tables can be queried
- **Column whitelist** — block access to sensitive columns (email, salary, SSN)
- **SELECT-only** — physically blocks INSERT, UPDATE, DELETE, DROP, and 15+ other statements
- **Anti-injection** — blocks UNION, stacked queries, subqueries in FROM
- **LLM fixup** — corrects common LLM SQL mistakes before they hit your DB
- **Bind variable helpers** — normalize and convert named/positional params
- **Row limits** — auto-appends LIMIT to prevent full table scans
- **Schema auto-discovery** — generate a whitelist from your PostgreSQL schema

## Install

```bash
npm install davoroh/sql-shield
```

## Works with any LLM tool

sql-shield is a security layer that works with whatever you already use:

- **Vanna AI** → pipe output through sql-shield
- **LangChain SQL Agent** → add sql-shield as validation step
- **Custom OpenAI/Anthropic prompt** → validate before executing
- **Any other tool** → if it produces SQL, sql-shield can validate it

## How it compares

Most text-to-SQL tools focus on **generating** SQL. sql-shield focuses on what happens **after** generation: validating, fixing, and enforcing security policy before the query reaches your database.

| Feature | Vanna AI | LangChain SQL | Wren AI | Dataherald | **sql-shield** |
|---------|----------|---------------|---------|------------|----------------|
| Table whitelist | No | Schema filter (not enforced) | Prompt-level only | No | **Code-enforced** |
| Column whitelist | No | No | No | No | **Code-enforced** |
| SELECT-only | Label only | Prompt only | Prompt only | Keyword blocklist | **Code-enforced** |
| Bind variables | No | No | No | No | **Yes** |
| Anti-injection (UNION, stacked) | No | No | Semicolon strip | No | **Yes** |
| SQL fixup | No | LLM checker (opt-in) | LLM retry loop | Agent retry loop | **Rule-based (9 rules)** |

> **Note:** sql-shield is not a replacement for these tools but complements them. Use your preferred engine for SQL generation, then pipe the output through sql-shield before executing.
>
> Comparison verified April 2026. Features may have changed since then.


## Quick start

### Validate a query

```javascript
import { validateSQL } from 'sql-shield';

const result = validateSQL("SELECT name, email FROM customers WHERE region = 'EU'", {
  allowedTables: ['customers', 'orders', 'products'],
  allowedColumns: {
    customers: ['name', 'region', 'segment'],  // email is NOT allowed
    orders: ['order_id', 'order_date', 'total'],
  },
  maxRows: 100,
});

// result:
// {
//   safe: false,
//   sql: null,
//   violations: [
//     { type: 'COLUMN_NOT_ALLOWED', table: 'CUSTOMERS', column: 'EMAIL' }
//   ]
// }
```

### Fix LLM mistakes

```javascript
import { fixupSQL } from 'sql-shield';

const fixed = fixupSQL(
  "SELECT COUNT(orders), name FROM custmers WHERE SUM(total) > 1000;",
  { knownTables: ['customers', 'orders', 'products'] },
);

// fixed:
// {
//   sql: "SELECT COUNT(*), name FROM CUSTOMERS HAVING SUM(total) > 1000",
//   corrections: [
//     { type: 'TABLE_FUZZY_MATCH', from: 'custmers', to: 'CUSTOMERS', distance: 1 },
//     { type: 'COUNT_TABLE_TO_STAR' },
//     { type: 'AGGREGATE_WHERE_TO_HAVING' },
//     { type: 'STRAY_SEMICOLON_REMOVED' }
//   ]
// }
```

### Full pipeline with any LLM

```javascript
import { validateSQL, fixupSQL } from 'sql-shield';
import OpenAI from 'openai';

const openai = new OpenAI();

// 1. Your LLM generates SQL (your prompt, your model)
const completion = await openai.chat.completions.create({
  model: 'gpt-4.1-mini',
  messages: [{ role: 'user', content: 'Show me top customers by revenue' }],
});
const rawSQL = completion.choices[0].message.content;

// 2. sql-shield fixes and validates
const fixed = fixupSQL(rawSQL, { knownTables: whitelist.tables });
const validation = validateSQL(fixed.sql, {
  allowedTables: whitelist.tables,
  allowedColumns: whitelist.columns,
  maxRows: 100,
});

// 3. Only execute if safe
if (validation.safe) {
  const result = await db.query(validation.sql);
}
```

### Auto-generate whitelist from your database

```javascript
import { generateWhitelist } from 'sql-shield/catalog';

const whitelist = await generateWhitelist({
  host: 'localhost',
  database: 'my_shop',
  schema: 'public',
  excludeTables: ['migrations', 'sessions', 'admin_users'],
});

// whitelist:
// {
//   tables: ['customers', 'orders', 'products', 'regions'],
//   columns: {
//     customers: ['customer_id', 'name', 'region', 'segment', ...],
//     orders: ['order_id', 'customer_id', 'order_date', 'total', ...],
//   }
// }
```

## API

### `validateSQL(sql, options)`

Validates SQL against a security policy.

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowedTables` | `string[]` | — | Whitelisted table names (case-insensitive) |
| `allowedColumns` | `{ table: string[] }` | — | Per-table whitelisted columns |
| `maxRows` | `number` | `200` | Auto-appends LIMIT if missing |
| `blockUnion` | `boolean` | `true` | Block UNION / UNION ALL |
| `blockSubqueries` | `boolean` | `true` | Block subqueries in FROM/JOIN |
| `blockStacked` | `boolean` | `true` | Block multiple statements |

**Returns:** `{ safe: boolean, sql: string|null, violations: Array<{ type: string, detail?: string, table?: string, column?: string }> }`

**Violation types:** `NOT_SELECT`, `FORBIDDEN_KEYWORD`, `STACKED_QUERIES`, `UNION`, `SUBQUERY_IN_FROM`, `TABLE_NOT_ALLOWED`, `COLUMN_NOT_ALLOWED`

### `fixupSQL(sql, options)`

Applies correction rules to LLM-generated SQL.

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `knownTables` | `string[]` | — | Known table names for fuzzy matching |
| `knownColumns` | `{ table: string[] }` | — | Per-table columns for heuristic matching |
| `fuzzyThreshold` | `number` | `0.85` | Table name similarity threshold (0–1) |

**Returns:** `{ sql: string, corrections: Array<{ type: string, from?: string, to?: string }> }`

**9 fixup rules:**
1. Fuzzy table name matching (Levenshtein distance)
2. Column-based table heuristic (when fuzzy match fails)
3. `COUNT(table)` → `COUNT(*)`
4. Case-insensitive LIKE wrapping (`UPPER()` on both sides)
5. Reserved word alias fix (CURRENT → CURR, PREVIOUS → PREV)
6. SQL keyword qualifier fix (WHERE.col → col)
7. Positional bind conversion ($1 → :b1)
8. Aggregate in WHERE → HAVING
9. Stray semicolon removal

### `normalizeBinds(binds)`

Normalizes bind variable keys: `{"$1": val}` → `{"b1": val}`.

### `toPositionalParams(sql, binds)`

Converts `:name` placeholders to `$N` positional params for PostgreSQL.
Safely skips `::` type casts (e.g. `column::integer` is not treated as a bind).

**Returns:** `{ sql: string, values: any[] }`

### `detectInterpolation(sql)`

Checks for potential string interpolation (unsafe patterns).

**Returns:** `{ safe: boolean, warnings: string[] }`

### `generateWhitelist(options)` (from `sql-shield/catalog`)

Auto-generates a table/column whitelist from PostgreSQL schema introspection.
Requires `pg` as a peer dependency (optional — only needed for this function).

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | `'localhost'` | PostgreSQL host |
| `port` | `number` | `5432` | PostgreSQL port |
| `database` | `string` | — | Database name (required) |
| `schema` | `string` | `'public'` | Schema to introspect |
| `user` | `string` | — | Database user |
| `password` | `string` | — | Database password |
| `excludeTables` | `string[]` | `[]` | Tables to exclude from the whitelist |
| `pool` | `pg.Pool` | — | Existing Pool instance (skips creating a new one) |

**Returns:** `Promise<{ tables: string[], columns: { [table]: string[] } }>`

## Zero dependencies

Core validate + fixup + bind functions have **zero npm dependencies**.

The optional `sql-shield/catalog` helper requires `pg` for PostgreSQL introspection.

## License

Apache 2.0 — see [LICENSE](LICENSE).
