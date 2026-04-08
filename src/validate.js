// sql-shield/src/validate.js
// SELECT-only validator + whitelist enforcement + anti-injection + limit rewriter
// SECURITY: This is the last line of defence between LLM output and the database.
// Zero dependencies.

function upper(s) {
  return String(s || '').toUpperCase();
}
function stripQuotes(s) {
  return String(s || '').replace(/"/g, '');
}

// -------------------- SQL SANITISATION --------------------

/** Strip SQL comments (block and line) before any validation. */
function stripComments(sql) {
  let result = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
  result = result.replace(/--[^\n\r]*/g, ' ');
  return result;
}

function isSelect(sql) {
  const clean = stripComments(sql || '');
  return /^\s*(WITH\b[\s\S]+?SELECT|SELECT)\b/i.test(clean);
}

function hasForbidden(sql) {
  const clean = stripComments(sql || '');
  return /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|TRUNCATE|CREATE|BEGIN|EXECUTE|EXEC|COMMIT|GRANT|REVOKE|EXPLAIN|CALL|SET|INTO\s+OUTFILE|INTO\s+DUMPFILE)\b/i.test(
    clean,
  );
}

/** Block stacked queries (multiple statements separated by semicolons). */
function hasStackedQueries(sql) {
  const clean = stripComments(sql || '');
  const noStrings = clean.replace(/'[^']*'/g, "''");
  return /;\s*\S/.test(noStrings);
}

/** Block UNION / UNION ALL — prevents combining with forbidden tables. */
function hasUnion(sql) {
  const clean = stripComments(sql || '');
  return /\bUNION\b/i.test(clean);
}

/** Block subqueries in FROM/JOIN — regex parser can't see inner table references. */
function hasSubqueryInFrom(sql) {
  const clean = stripComments(sql || '');
  return /\b(FROM|JOIN)\s*\(\s*SELECT\b/i.test(clean);
}

// -------------------- ALIAS MAP --------------------

function buildAliasMap(sql) {
  const up = upper(sql);
  const re = /\b(FROM|JOIN)\s+([A-Z0-9_.]+)(?:\s+([A-Z0-9_]+))?/gi;
  const aliasMap = {};
  let m;

  while ((m = re.exec(up)) !== null) {
    const tableToken = m[2];
    const aliasToken = m[3];
    const parts = tableToken.split('.');
    const table = parts.pop();
    const alias = aliasToken || table;
    aliasMap[alias] = { table };
  }

  return aliasMap;
}

// -------------------- TABLE PARSER FOR WHITELIST --------------------

/** Parse FROM/JOIN table references (not function FROM like EXTRACT ... FROM). */
function parseFromJoinTables(sql) {
  const entries = [];
  const ident = `(?:"?[A-Za-z0-9_]+"?(?:\\."?[A-Za-z0-9_]+"?)?)`;
  const alias = `(?:"?[A-Za-z0-9_]+"?)`;

  const lookForAlias = `\\s+(?:AS\\s+${alias}|${alias})`;
  const lookForClause = `\\s*(?:,|WHERE\\b|GROUP\\b|ORDER\\b|HAVING\\b|JOIN\\b|LEFT\\b|RIGHT\\b|FULL\\b|INNER\\b|OUTER\\b|ON\\b|;|$)`;
  const lookAhead = `(?:(?=${lookForAlias})|(?=${lookForClause}))`;
  const notClosingParen = `(?!\\s*\\))`;

  const re = new RegExp(`\\b(FROM|JOIN)\\s+(${ident})${notClosingParen}${lookAhead}`, 'ig');
  let m;
  while ((m = re.exec(sql)) !== null) {
    const raw = stripQuotes(m[2]);
    const parts = raw.split('.');
    const base = parts.length === 2 ? parts[1] : parts[0];
    entries.push(upper(base));
  }
  return Array.from(new Set(entries));
}

// -------------------- CTE NAME PARSER --------------------

/** Extract CTE names from WITH ... AS (...) so they pass the table whitelist. */
function parseCteNames(sql) {
  const names = [];
  const re = /(?:\bWITH\s+|,\s*|[)]\s*,\s*)("?[A-Za-z_][A-Za-z0-9_]*"?)\s+AS\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    names.push(upper(stripQuotes(m[1])));
  }
  return names;
}

/** Extract table references from inside CTE bodies. */
function parseTablesInCteBodies(sql) {
  const tables = [];
  const re = /\bAS\s*\(([\s\S]*?)\)/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const body = m[1];
    const tableRe = /\b(?:FROM|JOIN)\s+("?[A-Za-z_][A-Za-z0-9_.]*"?)/gi;
    let tm;
    while ((tm = tableRe.exec(body)) !== null) {
      const raw = stripQuotes(tm[1]);
      const parts = raw.split('.');
      tables.push(upper(parts[parts.length - 1]));
    }
  }
  return tables;
}

// -------------------- COLUMN WHITELIST (alias-aware) --------------------

function checkColumnWhitelist(sql, allowedColumnsUpper) {
  const up = upper(sql);
  const aliasMap = buildAliasMap(sql);
  const violations = [];

  const pairRe = /([A-Z_][A-Z0-9_]*)\.([A-Z_][A-Z0-9_]*)/g;
  let m;

  while ((m = pairRe.exec(up)) !== null) {
    const alias = m[1];
    const col = m[2];

    const aliasInfo = aliasMap[alias];
    if (!aliasInfo) continue;
    if (col === '*') continue;

    const tableName = aliasInfo.table;
    const allowed = allowedColumnsUpper[tableName];
    if (!allowed) continue; // no column whitelist for this table

    if (!allowed.includes(col)) {
      violations.push({
        type: 'COLUMN_NOT_ALLOWED',
        table: tableName,
        column: col,
      });
    }
  }

  return violations;
}

// -------------------- LIMIT --------------------

/** Enforce row limit if not already present. */
function ensureLimit(sql, maxRows) {
  const hasLimit = /\bLIMIT\s+\d+/i.test(sql);
  if (hasLimit) return sql;
  const trimmed = sql.replace(/\s+$/, '');
  return `${trimmed} LIMIT ${maxRows}`;
}

// -------------------- PUBLIC API --------------------

/**
 * Validate LLM-generated SQL against a security policy.
 *
 * Strips comments, enforces SELECT-only, blocks dangerous patterns
 * (UNION, stacked queries, subqueries in FROM), checks table/column
 * whitelists, and appends LIMIT if missing.
 *
 * @param {string} sql - Raw SQL from LLM
 * @param {object} options - Security policy
 * @param {string[]} [options.allowedTables] - Whitelisted table names (case-insensitive)
 * @param {Object<string, string[]>} [options.allowedColumns] - Per-table whitelisted columns
 * @param {number} [options.maxRows=200] - Max rows (appends LIMIT if missing)
 * @param {boolean} [options.blockUnion=true] - Block UNION/UNION ALL
 * @param {boolean} [options.blockSubqueries=true] - Block subqueries in FROM/JOIN
 * @param {boolean} [options.blockStacked=true] - Block stacked queries (multiple statements)
 * @returns {{ safe: boolean, sql: string|null, violations: Array<{type: string, detail?: string}> }}
 */
export function validateSQL(sql, options = {}) {
  const {
    allowedTables,
    allowedColumns,
    maxRows = 200,
    blockUnion = true,
    blockSubqueries = true,
    blockStacked = true,
  } = options;

  const violations = [];
  const sanitized = stripComments(String(sql || '').trim());

  // 1. SELECT-only check
  if (!isSelect(sanitized)) {
    violations.push({ type: 'NOT_SELECT', detail: 'Only SELECT statements are allowed' });
  }
  if (hasForbidden(sanitized)) {
    violations.push({ type: 'FORBIDDEN_KEYWORD', detail: 'Contains forbidden SQL keyword (INSERT, UPDATE, DELETE, DROP, etc.)' });
  }

  // 2. Dangerous patterns
  if (blockStacked && hasStackedQueries(sanitized)) {
    violations.push({ type: 'STACKED_QUERIES', detail: 'Multiple statements (stacked queries) are not allowed' });
  }
  if (blockUnion && hasUnion(sanitized)) {
    violations.push({ type: 'UNION', detail: 'UNION queries are not allowed' });
  }
  if (blockSubqueries && hasSubqueryInFrom(sanitized)) {
    violations.push({ type: 'SUBQUERY_IN_FROM', detail: 'Subqueries in FROM/JOIN are not allowed' });
  }

  // If already unsafe, return early (no point checking whitelist)
  if (violations.length) {
    return { safe: false, sql: null, violations };
  }

  // 3. Table whitelist
  if (allowedTables && allowedTables.length) {
    const allowed = new Set(allowedTables.map(upper));

    // CTEs are allowed implicitly
    const cteNames = parseCteNames(sanitized);
    for (const cte of cteNames) allowed.add(cte);

    const usedTables = parseFromJoinTables(sanitized);
    const cteTables = cteNames.length > 0 ? parseTablesInCteBodies(sanitized) : [];
    const allUsed = new Set([...usedTables, ...cteTables]);

    for (const t of allUsed) {
      if (!allowed.has(t)) {
        violations.push({ type: 'TABLE_NOT_ALLOWED', detail: t });
      }
    }
  }

  // 4. Column whitelist
  if (allowedColumns && Object.keys(allowedColumns).length) {
    const colsUpper = {};
    for (const [t, cols] of Object.entries(allowedColumns)) {
      colsUpper[upper(t)] = (cols || []).map(upper);
    }

    const colViolations = checkColumnWhitelist(sanitized, colsUpper);
    for (const v of colViolations) {
      violations.push(v);
    }
  }

  if (violations.length) {
    return { safe: false, sql: null, violations };
  }

  // 5. Enforce LIMIT
  const limited = ensureLimit(sanitized, maxRows);

  return { safe: true, sql: limited, violations: [] };
}
