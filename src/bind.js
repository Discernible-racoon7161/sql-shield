// sql-shield/src/bind.js
// Bind variable normalization and string interpolation detection.
// Zero dependencies.

/**
 * Normalize bind keys to :bN convention.
 * LLMs may return binds as {"$1": val}, {"1": val}, or {"b1": val}.
 *
 * @param {object} binds - Raw binds from LLM output
 * @returns {object} Normalized binds with bN keys
 *
 * @example
 * normalizeBinds({ "$1": "hello", "$2": 42 })
 * // → { b1: "hello", b2: 42 }
 */
export function normalizeBinds(binds) {
  if (!binds || typeof binds !== 'object' || Array.isArray(binds)) return binds;
  const out = {};
  for (const [key, val] of Object.entries(binds)) {
    const m = key.match(/^\$?(\d+)$/);
    if (m) {
      out['b' + m[1]] = val;
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Convert :bN named binds in SQL to $N positional params for PostgreSQL.
 * Returns the rewritten SQL and an ordered array of bind values.
 *
 * @param {string} sql - SQL with :bN placeholders
 * @param {object} binds - Bind values keyed by name (e.g. { b1: "hello", b2: 42 })
 * @returns {{ sql: string, values: any[] }}
 *
 * @example
 * toPositionalParams("SELECT * FROM t WHERE name = :b1 AND age > :b2", { b1: "Alice", b2: 30 })
 * // → { sql: "SELECT * FROM t WHERE name = $1 AND age > $2", values: ["Alice", 30] }
 */
export function toPositionalParams(sql, binds) {
  if (!sql) return { sql: '', values: [] };
  if (!binds || typeof binds !== 'object') return { sql, values: [] };

  const values = [];
  let paramIndex = 0;

  // Negative lookbehind (?<!:) avoids matching PostgreSQL type casts (::integer)
  const rewritten = sql.replace(/(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name) => {
    if (name in binds) {
      paramIndex++;
      values.push(binds[name]);
      return `$${paramIndex}`;
    }
    return match; // leave unmatched placeholders as-is
  });

  return { sql: rewritten, values };
}

/**
 * Detect potential string interpolation in SQL (unsafe patterns).
 * Returns true if the SQL appears to contain concatenated values
 * instead of bind variables.
 *
 * Checks for:
 * - String literals in WHERE/AND/OR conditions that look like user input (3+ chars)
 *
 * @param {string} sql - SQL to check
 * @returns {{ safe: boolean, warnings: string[] }}
 */
export function detectInterpolation(sql) {
  if (!sql) return { safe: true, warnings: [] };

  const warnings = [];

  // Detect string literals in WHERE/AND/OR conditions that look like user input
  // (longer than 2 chars, not SQL keywords like 'Y' or 'N')
  const stringLiterals = sql.match(/(?:WHERE|AND|OR)\s+\w+\s*=\s*'([^']{3,})'/gi);
  if (stringLiterals && stringLiterals.length) {
    warnings.push(
      `Found ${stringLiterals.length} string literal(s) in conditions — consider using bind variables`,
    );
  }

  return { safe: warnings.length === 0, warnings };
}
