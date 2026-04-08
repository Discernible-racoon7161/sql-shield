import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBinds, toPositionalParams, detectInterpolation } from '../src/bind.js';

describe('normalizeBinds', () => {
  it('converts $N keys to bN', () => {
    const r = normalizeBinds({ $1: 'hello', $2: 42 });
    assert.deepEqual(r, { b1: 'hello', b2: 42 });
  });

  it('converts numeric-only keys to bN', () => {
    const r = normalizeBinds({ 1: 'hello', 2: 42 });
    assert.deepEqual(r, { b1: 'hello', b2: 42 });
  });

  it('leaves bN keys unchanged', () => {
    const r = normalizeBinds({ b1: 'hello', b2: 42 });
    assert.deepEqual(r, { b1: 'hello', b2: 42 });
  });

  it('leaves named keys unchanged', () => {
    const r = normalizeBinds({ userId: 'abc', limit: 10 });
    assert.deepEqual(r, { userId: 'abc', limit: 10 });
  });

  it('handles mixed keys', () => {
    const r = normalizeBinds({ $1: 'a', b2: 'b', name: 'c' });
    assert.deepEqual(r, { b1: 'a', b2: 'b', name: 'c' });
  });

  it('returns null/undefined as-is', () => {
    assert.equal(normalizeBinds(null), null);
    assert.equal(normalizeBinds(undefined), undefined);
  });

  it('returns arrays as-is', () => {
    const arr = [1, 2, 3];
    assert.deepEqual(normalizeBinds(arr), arr);
  });
});

describe('toPositionalParams', () => {
  it('converts :bN to $N with ordered values', () => {
    const r = toPositionalParams('SELECT * FROM t WHERE name = :b1 AND age > :b2', {
      b1: 'Alice',
      b2: 30,
    });
    assert.equal(r.sql, 'SELECT * FROM t WHERE name = $1 AND age > $2');
    assert.deepEqual(r.values, ['Alice', 30]);
  });

  it('converts named params', () => {
    const r = toPositionalParams('SELECT * FROM t WHERE name = :name AND id = :id', {
      name: 'Bob',
      id: 5,
    });
    assert.equal(r.sql, 'SELECT * FROM t WHERE name = $1 AND id = $2');
    assert.deepEqual(r.values, ['Bob', 5]);
  });

  it('does not match PostgreSQL type casts (::integer)', () => {
    const r = toPositionalParams('SELECT total::integer FROM t WHERE id = :b1', { b1: 5 });
    assert.equal(r.sql, 'SELECT total::integer FROM t WHERE id = $1');
    assert.deepEqual(r.values, [5]);
  });

  it('handles repeated bind names', () => {
    const r = toPositionalParams('SELECT * FROM t WHERE a = :b1 OR b = :b1', { b1: 'x' });
    assert.equal(r.sql, 'SELECT * FROM t WHERE a = $1 OR b = $2');
    assert.deepEqual(r.values, ['x', 'x']);
  });

  it('leaves unmatched placeholders as-is', () => {
    const r = toPositionalParams('SELECT * FROM t WHERE id = :unknown', { b1: 'x' });
    assert.ok(r.sql.includes(':unknown'));
    assert.equal(r.values.length, 0);
  });

  it('handles empty SQL', () => {
    const r = toPositionalParams('', { b1: 'x' });
    assert.equal(r.sql, '');
    assert.deepEqual(r.values, []);
  });

  it('handles null binds', () => {
    const r = toPositionalParams('SELECT 1', null);
    assert.equal(r.sql, 'SELECT 1');
    assert.deepEqual(r.values, []);
  });
});

describe('detectInterpolation', () => {
  it('flags long string literals in WHERE', () => {
    const r = detectInterpolation("SELECT * FROM t WHERE name = 'John Smith'");
    assert.equal(r.safe, false);
    assert.ok(r.warnings.length > 0);
  });

  it('accepts short string literals (Y/N flags)', () => {
    const r = detectInterpolation("SELECT * FROM t WHERE active = 'Y'");
    assert.equal(r.safe, true);
  });

  it('accepts bind variables', () => {
    const r = detectInterpolation('SELECT * FROM t WHERE name = :b1');
    assert.equal(r.safe, true);
  });

  it('handles empty input', () => {
    const r = detectInterpolation('');
    assert.equal(r.safe, true);
  });

  it('handles null input', () => {
    const r = detectInterpolation(null);
    assert.equal(r.safe, true);
  });
});
