import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSQL } from '../src/validate.js';

describe('validateSQL', () => {
  // ---------- SELECT-only ----------
  describe('SELECT-only enforcement', () => {
    it('allows simple SELECT', () => {
      const r = validateSQL('SELECT name FROM customers');
      assert.equal(r.safe, true);
      assert.ok(r.sql);
    });

    it('allows SELECT with WITH (CTE)', () => {
      const r = validateSQL('WITH cte AS (SELECT 1) SELECT * FROM cte');
      assert.equal(r.safe, true);
    });

    it('blocks INSERT', () => {
      const r = validateSQL("INSERT INTO customers (name) VALUES ('test')");
      assert.equal(r.safe, false);
      assert.ok(r.violations.some((v) => v.type === 'NOT_SELECT' || v.type === 'FORBIDDEN_KEYWORD'));
    });

    it('blocks UPDATE', () => {
      const r = validateSQL("UPDATE customers SET name = 'x'");
      assert.equal(r.safe, false);
    });

    it('blocks DELETE', () => {
      const r = validateSQL('DELETE FROM customers');
      assert.equal(r.safe, false);
    });

    it('blocks DROP TABLE', () => {
      const r = validateSQL('DROP TABLE customers');
      assert.equal(r.safe, false);
    });

    it('blocks TRUNCATE', () => {
      const r = validateSQL('TRUNCATE customers');
      assert.equal(r.safe, false);
    });

    it('blocks ALTER TABLE', () => {
      const r = validateSQL('ALTER TABLE customers ADD COLUMN age INT');
      assert.equal(r.safe, false);
    });

    it('blocks GRANT', () => {
      const r = validateSQL('GRANT ALL ON customers TO public');
      assert.equal(r.safe, false);
    });

    it('blocks SELECT INTO OUTFILE', () => {
      const r = validateSQL("SELECT * FROM customers INTO OUTFILE '/tmp/data.csv'");
      assert.equal(r.safe, false);
    });
  });

  // ---------- Comment stripping ----------
  describe('comment stripping', () => {
    it('strips block comments before validation', () => {
      const r = validateSQL('SELECT /* this is safe */ name FROM customers');
      assert.equal(r.safe, true);
    });

    it('strips line comments before validation', () => {
      const r = validateSQL('SELECT name FROM customers -- innocent comment');
      assert.equal(r.safe, true);
    });

    it('detects forbidden keyword hidden in block comment trick', () => {
      // If someone tries: SELECT * FROM t; DROP/* */TABLE t
      const r = validateSQL('DROP/* hiding */TABLE customers');
      assert.equal(r.safe, false);
    });
  });

  // ---------- Anti-injection patterns ----------
  describe('anti-injection', () => {
    it('blocks UNION by default', () => {
      const r = validateSQL("SELECT name FROM customers UNION SELECT password FROM admin_users");
      assert.equal(r.safe, false);
      assert.ok(r.violations.some((v) => v.type === 'UNION'));
    });

    it('allows UNION when blockUnion=false', () => {
      const r = validateSQL(
        "SELECT name FROM customers UNION SELECT name FROM suppliers",
        { allowedTables: ['customers', 'suppliers'], blockUnion: false },
      );
      assert.equal(r.safe, true);
    });

    it('blocks stacked queries', () => {
      const r = validateSQL("SELECT 1; DROP TABLE customers");
      assert.equal(r.safe, false);
      assert.ok(r.violations.some((v) => v.type === 'STACKED_QUERIES' || v.type === 'FORBIDDEN_KEYWORD'));
    });

    it('allows semicolons inside string literals', () => {
      const r = validateSQL("SELECT name FROM customers WHERE note = 'has;semicolon'");
      assert.equal(r.safe, true);
    });

    it('blocks subqueries in FROM', () => {
      const r = validateSQL('SELECT * FROM (SELECT * FROM secret_table) t');
      assert.equal(r.safe, false);
      assert.ok(r.violations.some((v) => v.type === 'SUBQUERY_IN_FROM'));
    });

    it('allows subqueries in FROM when blockSubqueries=false', () => {
      const r = validateSQL(
        'SELECT * FROM (SELECT id FROM customers) t',
        { blockSubqueries: false },
      );
      assert.equal(r.safe, true);
    });
  });

  // ---------- Table whitelist ----------
  describe('table whitelist', () => {
    const opts = { allowedTables: ['customers', 'orders'] };

    it('allows whitelisted tables', () => {
      const r = validateSQL('SELECT name FROM customers', opts);
      assert.equal(r.safe, true);
    });

    it('blocks non-whitelisted table', () => {
      const r = validateSQL('SELECT * FROM admin_users', opts);
      assert.equal(r.safe, false);
      assert.ok(r.violations.some((v) => v.type === 'TABLE_NOT_ALLOWED' && v.detail === 'ADMIN_USERS'));
    });

    it('handles schema-qualified tables (schema.table)', () => {
      const r = validateSQL('SELECT name FROM public.customers', opts);
      assert.equal(r.safe, true);
    });

    it('is case-insensitive', () => {
      const r = validateSQL('SELECT name FROM CUSTOMERS', opts);
      assert.equal(r.safe, true);
    });

    it('allows CTE names implicitly', () => {
      const r = validateSQL(
        'WITH summary AS (SELECT client_id, COUNT(*) AS cnt FROM orders GROUP BY client_id) SELECT * FROM summary',
        opts,
      );
      assert.equal(r.safe, true);
    });

    it('checks tables inside CTE bodies', () => {
      const r = validateSQL(
        'WITH x AS (SELECT * FROM secret_table) SELECT * FROM x',
        opts,
      );
      assert.equal(r.safe, false);
      assert.ok(r.violations.some((v) => v.type === 'TABLE_NOT_ALLOWED'));
    });

    it('skips table check when allowedTables is empty', () => {
      const r = validateSQL('SELECT * FROM anything');
      assert.equal(r.safe, true);
    });
  });

  // ---------- Column whitelist ----------
  describe('column whitelist', () => {
    const opts = {
      allowedTables: ['customers'],
      allowedColumns: {
        customers: ['name', 'region', 'segment'],
      },
    };

    it('allows whitelisted columns', () => {
      const r = validateSQL('SELECT c.name, c.region FROM customers c', opts);
      assert.equal(r.safe, true);
    });

    it('blocks non-whitelisted column', () => {
      const r = validateSQL('SELECT c.email FROM customers c', opts);
      assert.equal(r.safe, false);
      assert.ok(r.violations.some((v) => v.type === 'COLUMN_NOT_ALLOWED' && v.column === 'EMAIL'));
    });

    it('is case-insensitive for columns', () => {
      const r = validateSQL('SELECT c.NAME FROM customers c', opts);
      assert.equal(r.safe, true);
    });

    it('skips column check for tables without column whitelist', () => {
      const r = validateSQL('SELECT o.anything FROM orders o', {
        allowedTables: ['orders'],
        allowedColumns: {}, // no column whitelist for orders
      });
      assert.equal(r.safe, true);
    });
  });

  // ---------- LIMIT enforcement ----------
  describe('LIMIT enforcement', () => {
    it('appends LIMIT when not present', () => {
      const r = validateSQL('SELECT name FROM customers', { maxRows: 50 });
      assert.equal(r.safe, true);
      assert.match(r.sql, /LIMIT 50$/);
    });

    it('preserves existing LIMIT', () => {
      const r = validateSQL('SELECT name FROM customers LIMIT 10', { maxRows: 50 });
      assert.equal(r.safe, true);
      assert.ok(!r.sql.includes('LIMIT 50'));
      assert.ok(r.sql.includes('LIMIT 10'));
    });

    it('defaults to LIMIT 200', () => {
      const r = validateSQL('SELECT name FROM customers');
      assert.equal(r.safe, true);
      assert.match(r.sql, /LIMIT 200$/);
    });
  });

  // ---------- Edge cases ----------
  describe('edge cases', () => {
    it('handles empty input', () => {
      const r = validateSQL('');
      assert.equal(r.safe, false);
    });

    it('handles null input', () => {
      const r = validateSQL(null);
      assert.equal(r.safe, false);
    });

    it('handles whitespace-only input', () => {
      const r = validateSQL('   ');
      assert.equal(r.safe, false);
    });

    it('returns all violations (not just first)', () => {
      const r = validateSQL('INSERT INTO t VALUES (1); DROP TABLE t');
      assert.ok(r.violations.length >= 2);
    });
  });
});
