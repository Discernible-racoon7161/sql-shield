import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixupSQL } from '../src/fixup.js';

describe('fixupSQL', () => {
  // ---------- Fuzzy table matching ----------
  describe('fuzzy table matching', () => {
    it('corrects misspelled table name', () => {
      const r = fixupSQL('SELECT * FROM custmers', {
        knownTables: ['customers', 'orders'],
      });
      assert.ok(r.sql.includes('customers') || r.sql.includes('CUSTOMERS'));
      assert.ok(r.corrections.some((c) => c.type === 'TABLE_FUZZY_MATCH'));
    });

    it('leaves correct table name untouched', () => {
      const r = fixupSQL('SELECT * FROM customers', {
        knownTables: ['customers', 'orders'],
      });
      assert.equal(r.sql, 'SELECT * FROM customers');
      assert.equal(r.corrections.length, 0);
    });

    it('does not match when distance is too large', () => {
      const r = fixupSQL('SELECT * FROM xyz', {
        knownTables: ['customers', 'orders'],
      });
      assert.ok(!r.corrections.some((c) => c.type === 'TABLE_FUZZY_MATCH'));
    });

    it('handles schema-qualified table names', () => {
      const r = fixupSQL('SELECT * FROM public.custmers', {
        knownTables: ['customers', 'orders'],
      });
      assert.ok(r.corrections.some((c) => c.type === 'TABLE_FUZZY_MATCH'));
    });
  });

  // ---------- Column-based heuristic ----------
  describe('column-based table matching', () => {
    it('matches table by column usage', () => {
      const r = fixupSQL('SELECT t.order_date, t.total FROM wrong_table t', {
        knownTables: ['customers', 'orders'],
        knownColumns: {
          customers: ['name', 'region'],
          orders: ['order_date', 'total', 'status'],
        },
      });
      assert.ok(r.corrections.some((c) => c.type === 'TABLE_COLUMN_MATCH' && c.to === 'ORDERS'));
    });
  });

  // ---------- COUNT(table) → COUNT(*) ----------
  describe('COUNT fix', () => {
    it('fixes COUNT(TABLE_NAME) to COUNT(*)', () => {
      const r = fixupSQL('SELECT COUNT(customers) FROM customers');
      assert.ok(r.sql.includes('COUNT(*)'));
      assert.ok(r.corrections.some((c) => c.type === 'COUNT_TABLE_TO_STAR'));
    });

    it('fixes COUNT("TABLE_NAME") to COUNT(*)', () => {
      const r = fixupSQL('SELECT COUNT("DOC_NAR_KUPCA") FROM orders');
      assert.ok(r.sql.includes('COUNT(*)'));
    });

    it('does not touch COUNT(*)', () => {
      const r = fixupSQL('SELECT COUNT(*) FROM orders');
      assert.ok(r.sql.includes('COUNT(*)'));
      assert.ok(!r.corrections.some((c) => c.type === 'COUNT_TABLE_TO_STAR'));
    });
  });

  // ---------- Case-insensitive LIKE ----------
  describe('case-insensitive LIKE', () => {
    it('wraps LIKE in UPPER()', () => {
      const r = fixupSQL("SELECT * FROM t WHERE name LIKE 'alice'");
      assert.ok(r.sql.includes('UPPER(name)'));
      assert.ok(r.sql.includes("UPPER('alice')"));
      assert.ok(r.corrections.some((c) => c.type === 'CASE_INSENSITIVE_LIKE'));
    });

    it('wraps NOT LIKE in UPPER()', () => {
      const r = fixupSQL("SELECT * FROM t WHERE name NOT LIKE 'bob'");
      assert.ok(r.sql.includes('UPPER(name)'));
    });

    it('handles bind variables', () => {
      const r = fixupSQL('SELECT * FROM t WHERE name LIKE :b1');
      assert.ok(r.sql.includes('UPPER(name)'));
      assert.ok(r.sql.includes('UPPER(:b1)'));
    });

    it('does not double-wrap UPPER', () => {
      const r = fixupSQL("SELECT * FROM t WHERE UPPER(name) LIKE UPPER('test')");
      assert.ok(!r.sql.includes('UPPER(UPPER'));
    });
  });

  // ---------- Reserved aliases ----------
  describe('reserved alias fix', () => {
    it('renames current → CURR', () => {
      const r = fixupSQL('SELECT current.name FROM orders current');
      assert.ok(r.sql.includes('CURR.name'));
      assert.ok(r.sql.includes('orders CURR'));
      assert.ok(r.corrections.some((c) => c.type === 'RESERVED_ALIAS_FIX'));
    });

    it('renames previous → PREV', () => {
      const r = fixupSQL('SELECT previous.total FROM orders previous');
      assert.ok(r.sql.includes('PREV.total'));
    });
  });

  // ---------- Positional binds ----------
  describe('positional binds fix', () => {
    it('converts $1, $2 to :b1, :b2', () => {
      const r = fixupSQL('SELECT * FROM t WHERE id = $1 AND name = $2');
      assert.ok(r.sql.includes(':b1'));
      assert.ok(r.sql.includes(':b2'));
      assert.ok(!r.sql.includes('$1'));
      assert.ok(r.corrections.some((c) => c.type === 'POSITIONAL_BINDS_FIX'));
    });

    it('does not touch SQL already using :bN', () => {
      const r = fixupSQL('SELECT * FROM t WHERE id = :b1');
      assert.ok(!r.corrections.some((c) => c.type === 'POSITIONAL_BINDS_FIX'));
    });
  });

  // ---------- Aggregate in WHERE → HAVING ----------
  describe('aggregate WHERE → HAVING', () => {
    it('moves SUM from WHERE to HAVING', () => {
      const r = fixupSQL(
        'SELECT region, SUM(total) FROM orders GROUP BY region WHERE SUM(total) > 1000',
      );
      assert.ok(r.sql.includes('HAVING'));
      assert.ok(r.corrections.some((c) => c.type === 'AGGREGATE_WHERE_TO_HAVING'));
    });

    it('moves COUNT from WHERE to HAVING', () => {
      const r = fixupSQL(
        'SELECT region, COUNT(*) FROM orders GROUP BY region WHERE COUNT(*) > 5',
      );
      assert.ok(r.sql.includes('HAVING'));
    });
  });

  // ---------- Keyword qualifiers ----------
  describe('keyword qualifier fix', () => {
    it('removes WHERE.col → col', () => {
      const r = fixupSQL('SELECT WHERE.name FROM customers');
      assert.ok(r.sql.includes('SELECT name'));
      assert.ok(!r.sql.includes('WHERE.name'));
      assert.ok(r.corrections.some((c) => c.type === 'KEYWORD_QUALIFIER_FIX'));
    });
  });

  // ---------- Stray semicolons ----------
  describe('stray semicolons', () => {
    it('removes trailing semicolon', () => {
      const r = fixupSQL('SELECT * FROM t;');
      assert.ok(!r.sql.endsWith(';'));
      assert.ok(r.corrections.some((c) => c.type === 'STRAY_SEMICOLON_REMOVED'));
    });

    it('removes semicolon before LIMIT', () => {
      const r = fixupSQL('SELECT * FROM t; LIMIT 10');
      assert.ok(r.sql.includes('LIMIT 10'));
      assert.ok(!r.sql.includes(';'));
    });
  });

  // ---------- Edge cases ----------
  describe('edge cases', () => {
    it('handles empty input', () => {
      const r = fixupSQL('');
      assert.equal(r.sql, '');
      assert.equal(r.corrections.length, 0);
    });

    it('handles null input', () => {
      const r = fixupSQL(null);
      assert.equal(r.sql, '');
    });

    it('applies multiple fixes in one pass', () => {
      const r = fixupSQL("SELECT COUNT(orders) FROM custmers WHERE name LIKE 'test';", {
        knownTables: ['customers', 'orders'],
      });
      assert.ok(r.corrections.length >= 2);
    });
  });
});
