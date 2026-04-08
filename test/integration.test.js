// Integration tests — requires a running PostgreSQL with sql_shield_test schema.
// Run: npm run test:integration
// Setup: node test/fixtures/setup-db.js

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { validateSQL, fixupSQL, toPositionalParams, normalizeBinds } from '../src/index.js';
import { generateWhitelist } from '../src/catalog.js';

const PG_CONFIG = {
  host: process.env.PG_HOST || 'localhost',
  port: Number(process.env.PG_PORT || 15432),
  database: process.env.PG_DATABASE || 'pharma_platform',
  user: process.env.PG_USER || 'pharma_admin_app',
  password: process.env.PG_PASSWORD || '',
};

const SCHEMA = 'sql_shield_test';

let pool;
let whitelist;

describe('Integration: generateWhitelist', () => {
  before(async () => {
    pool = new pg.Pool({ ...PG_CONFIG, max: 3 });
    // Verify connection
    const r = await pool.query('SELECT 1 AS ok');
    assert.equal(r.rows[0].ok, 1);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  it('discovers all tables and views from schema', async () => {
    whitelist = await generateWhitelist({
      ...PG_CONFIG,
      schema: SCHEMA,
    });

    assert.ok(whitelist.tables.length >= 4, `Expected >=4 tables, got ${whitelist.tables.length}`);
    assert.ok(whitelist.tables.includes('customers'), 'Should include customers');
    assert.ok(whitelist.tables.includes('orders'), 'Should include orders');
    assert.ok(whitelist.tables.includes('products'), 'Should include products');
    assert.ok(whitelist.tables.includes('v_customer_orders'), 'Should include view');
    assert.ok(whitelist.tables.includes('migrations'), 'Should include migrations (not excluded)');
  });

  it('excludes tables when excludeTables is set', async () => {
    const wl = await generateWhitelist({
      ...PG_CONFIG,
      schema: SCHEMA,
      excludeTables: ['migrations'],
    });

    assert.ok(!wl.tables.includes('migrations'), 'migrations should be excluded');
    assert.ok(wl.tables.includes('customers'), 'customers should remain');
    assert.ok(!wl.columns['migrations'], 'migrations columns should be excluded');
  });

  it('returns correct columns for each table', async () => {
    const wl = await generateWhitelist({
      ...PG_CONFIG,
      schema: SCHEMA,
    });

    assert.ok(wl.columns['customers'], 'Should have customer columns');
    assert.ok(wl.columns['customers'].includes('customer_id'));
    assert.ok(wl.columns['customers'].includes('name'));
    assert.ok(wl.columns['customers'].includes('region'));
    assert.ok(wl.columns['customers'].includes('email'));

    assert.ok(wl.columns['orders'], 'Should have order columns');
    assert.ok(wl.columns['orders'].includes('order_id'));
    assert.ok(wl.columns['orders'].includes('total'));
  });

  it('accepts an existing pool instead of creating one', async () => {
    const wl = await generateWhitelist({
      schema: SCHEMA,
      pool,
    });

    assert.ok(wl.tables.length >= 4);
    // Pool should still be usable after (not closed)
    const r = await pool.query('SELECT 1 AS ok');
    assert.equal(r.rows[0].ok, 1);
  });
});

describe('Integration: validateSQL against real schema', () => {
  before(async () => {
    pool = new pg.Pool({ ...PG_CONFIG, max: 3 });
    whitelist = await generateWhitelist({
      schema: SCHEMA,
      pool,
      excludeTables: ['migrations'],
    });
  });

  after(async () => {
    if (pool) await pool.end();
  });

  it('validates a correct query', () => {
    const r = validateSQL(
      'SELECT c.name, c.region FROM customers c WHERE c.segment = :b1',
      {
        allowedTables: whitelist.tables,
        allowedColumns: whitelist.columns,
        maxRows: 50,
      },
    );
    assert.equal(r.safe, true);
    assert.match(r.sql, /LIMIT 50/);
  });

  it('blocks a query using excluded table', () => {
    const r = validateSQL('SELECT * FROM migrations', {
      allowedTables: whitelist.tables,
    });
    assert.equal(r.safe, false);
    assert.ok(r.violations.some((v) => v.type === 'TABLE_NOT_ALLOWED'));
  });

  it('blocks access to email column when not in whitelist', () => {
    // Create a restricted whitelist without email
    const restrictedColumns = { ...whitelist.columns };
    restrictedColumns['customers'] = restrictedColumns['customers'].filter(
      (c) => c !== 'email',
    );

    const r = validateSQL('SELECT c.email FROM customers c', {
      allowedTables: whitelist.tables,
      allowedColumns: restrictedColumns,
    });
    assert.equal(r.safe, false);
    assert.ok(r.violations.some((v) => v.type === 'COLUMN_NOT_ALLOWED' && v.column === 'EMAIL'));
  });

  it('blocks DROP TABLE injection', () => {
    const r = validateSQL('DROP TABLE customers', {
      allowedTables: whitelist.tables,
    });
    assert.equal(r.safe, false);
  });

  it('blocks UNION injection', () => {
    const r = validateSQL(
      "SELECT name FROM customers UNION SELECT version FROM pg_settings",
      { allowedTables: whitelist.tables },
    );
    assert.equal(r.safe, false);
    assert.ok(r.violations.some((v) => v.type === 'UNION'));
  });

  it('blocks stacked query injection', () => {
    const r = validateSQL(
      "SELECT name FROM customers; DELETE FROM customers",
      { allowedTables: whitelist.tables },
    );
    assert.equal(r.safe, false);
  });
});

describe('Integration: fixupSQL + validateSQL + execute on real PG', () => {
  before(async () => {
    pool = new pg.Pool({ ...PG_CONFIG, max: 3 });
    whitelist = await generateWhitelist({
      schema: SCHEMA,
      pool,
      excludeTables: ['migrations'],
    });
  });

  after(async () => {
    if (pool) await pool.end();
  });

  it('full pipeline: fixup → validate → execute (simple SELECT)', async () => {
    const rawSQL = 'SELECT name, region FROM custmers';

    // 1. Fixup
    const fixed = fixupSQL(rawSQL, {
      knownTables: whitelist.tables,
      knownColumns: whitelist.columns,
    });
    assert.ok(fixed.corrections.length > 0, 'Should have corrections');

    // 2. Validate
    const validated = validateSQL(fixed.sql, {
      allowedTables: whitelist.tables,
      allowedColumns: whitelist.columns,
      maxRows: 10,
    });
    assert.equal(validated.safe, true, `Should be safe, violations: ${JSON.stringify(validated.violations)}`);

    // 3. Execute against real PG
    const result = await pool.query(`SET search_path TO ${SCHEMA}; ${validated.sql}`);
    // Multi-statement returns array; last result has the rows
    const rows = Array.isArray(result) ? result[result.length - 1].rows : result.rows;
    assert.ok(rows.length > 0, 'Should return rows');
    assert.ok(rows[0].name, 'Should have name column');
  });

  it('full pipeline: fixup → validate → bind → execute (parameterized)', async () => {
    const rawSQL = "SELECT name, region FROM customers WHERE region = $1";
    const rawBinds = { '$1': 'EU' };

    // 1. Fixup
    const fixed = fixupSQL(rawSQL, { knownTables: whitelist.tables });

    // 2. Validate
    const validated = validateSQL(fixed.sql, {
      allowedTables: whitelist.tables,
      maxRows: 50,
    });
    assert.equal(validated.safe, true);

    // 3. Normalize binds and convert to positional
    const normalized = normalizeBinds(rawBinds);
    const { sql: pgSQL, values } = toPositionalParams(validated.sql, normalized);

    // 4. Execute with real PG
    await pool.query(`SET search_path TO ${SCHEMA}`);
    const result = await pool.query(pgSQL, values);
    assert.ok(result.rows.length > 0, 'Should return EU customers');
    for (const row of result.rows) {
      assert.equal(row.region, 'EU');
    }
  });

  it('full pipeline: aggregate query with GROUP BY', async () => {
    const rawSQL = `
      SELECT c.region, COUNT(*) AS order_count, SUM(o.total) AS revenue
      FROM customers c
      JOIN orders o ON o.customer_id = c.customer_id
      GROUP BY c.region
      ORDER BY revenue DESC
    `;

    const validated = validateSQL(rawSQL, {
      allowedTables: whitelist.tables,
      allowedColumns: whitelist.columns,
      maxRows: 100,
    });
    assert.equal(validated.safe, true);

    await pool.query(`SET search_path TO ${SCHEMA}`);
    const result = await pool.query(validated.sql);
    assert.ok(result.rows.length > 0, 'Should return aggregated results');
    assert.ok(result.rows[0].revenue, 'Should have revenue');
    assert.ok(result.rows[0].order_count, 'Should have order_count');
  });

  it('full pipeline: query against view', async () => {
    const rawSQL = 'SELECT customer_name, total, status FROM v_customer_orders WHERE status = :b1';

    const validated = validateSQL(rawSQL, {
      allowedTables: whitelist.tables,
      allowedColumns: whitelist.columns,
      maxRows: 50,
    });
    assert.equal(validated.safe, true);

    const { sql, values } = toPositionalParams(validated.sql, { b1: 'shipped' });
    await pool.query(`SET search_path TO ${SCHEMA}`);
    const result = await pool.query(sql, values);
    assert.ok(result.rows.length > 0, 'Should return shipped orders');
    for (const row of result.rows) {
      assert.equal(row.status, 'shipped');
    }
  });

  it('full pipeline: fixup COUNT(table) → execute', async () => {
    const rawSQL = 'SELECT COUNT(customers) FROM customers';

    const fixed = fixupSQL(rawSQL, { knownTables: whitelist.tables });
    assert.ok(fixed.sql.includes('COUNT(*)'));

    const validated = validateSQL(fixed.sql, {
      allowedTables: whitelist.tables,
      maxRows: 10,
    });
    assert.equal(validated.safe, true);

    await pool.query(`SET search_path TO ${SCHEMA}`);
    const result = await pool.query(validated.sql);
    assert.equal(Number(result.rows[0].count), 5);
  });

  it('rejects and does NOT execute dangerous SQL', async () => {
    const dangerous = "SELECT 1; DELETE FROM customers";

    const validated = validateSQL(dangerous, {
      allowedTables: whitelist.tables,
    });
    assert.equal(validated.safe, false, 'Should be rejected');

    // Verify data was NOT affected
    await pool.query(`SET search_path TO ${SCHEMA}`);
    const result = await pool.query('SELECT COUNT(*) FROM customers');
    assert.equal(Number(result.rows[0].count), 5, 'All 5 customers should still exist');
  });
});
