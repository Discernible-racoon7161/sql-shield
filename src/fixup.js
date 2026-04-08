// sql-shield/src/fixup.js
// Post-LLM SQL correction rules.
// Fixes common mistakes LLMs make when generating SQL.
// Zero dependencies.

function upper(s) {
  return String(s || '').toUpperCase();
}
function stripQuotes(s) {
  return String(s || '').replace(/"/g, '');
}

// -------------------- CATALOG INDEX --------------------

function buildCatalogIndex(knownTables, knownColumns) {
  const tableSet = new Set((knownTables || []).map(upper));
  const colsByTable = {};
  if (knownColumns) {
    for (const [t, cols] of Object.entries(knownColumns)) {
      colsByTable[upper(t)] = new Set((cols || []).map(upper));
    }
  }
  return { tableSet, colsByTable };
}

// -------------------- LEVENSHTEIN --------------------

/** Levenshtein edit distance between two strings. */
function levenshtein(a, b) {
  const m = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      m[i][j] =
        b.charAt(i - 1) === a.charAt(j - 1)
          ? m[i - 1][j - 1]
          : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
    }
  }
  return m[b.length][a.length];
}

/**
 * Fuzzy-match a table name against known tables.
 * Returns the matching table name or null.
 *
 * @param {string} name - Table name to match
 * @param {Set<string>} tableSet - Known table names (UPPER)
 * @param {number} [threshold=0.85] - Similarity threshold (0-1)
 * @returns {string|null}
 */
function fuzzyMatchTable(name, tableSet, threshold = 0.85) {
  const s = upper(name);
  if (tableSet.has(s)) return s;
  let best = null;
  for (const t of tableSet) {
    const d = levenshtein(s, t);
    const score = 1 - d / Math.max(s.length, t.length);
    if (score > threshold) {
      if (!best || score > best.score) best = { table: t, score };
    }
  }
  return best ? best.table : null;
}

// -------------------- FROM/JOIN PARSER --------------------

/** Parse FROM/JOIN table references (not function FROM like EXTRACT ... FROM). */
function parseFromJoins(sql) {
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
    const keyword = m[1];
    const raw = stripQuotes(m[2]);
    const parts = raw.split('.');
    const owner = parts.length === 2 ? parts[0] : null;
    const base = parts.length === 2 ? parts[1] : parts[0];
    entries.push({ keyword, start: m.index, end: re.lastIndex, owner, base, raw });
  }
  return entries;
}

// -------------------- COLUMN USAGE --------------------

function extractColumnUsage(sql, tableSet) {
  const qualified = {};
  const unqualified = new Set();

  const reQ = /\b([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\b/g;
  let m;
  while ((m = reQ.exec(sql)) !== null) {
    const t = upper(m[1]);
    const c = upper(m[2]);
    if (!qualified[t]) qualified[t] = new Set();
    qualified[t].add(c);
  }

  const tokens = sql
    .replace(/'[^']*'/g, ' ')
    .replace(/"[^"]*"/g, ' ')
    .split(/[^A-Za-z0-9_]+/)
    .filter(Boolean)
    .map(upper);

  const stop = new Set([
    'SELECT', 'WITH', 'WHERE', 'FROM', 'JOIN', 'LEFT', 'RIGHT', 'FULL',
    'INNER', 'OUTER', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'AND',
    'OR', 'NOT', 'NULL', 'IS', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE',
    'END', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'FETCH',
    'FIRST', 'ROWS', 'ONLY', 'ROWNUM', 'OFFSET', 'LIMIT', 'UNION', 'ALL',
  ]);
  for (const wt of tableSet) stop.add(wt);

  for (const t of tokens) {
    if (!stop.has(t) && !/^\d+$/.test(t)) unqualified.add(t);
  }
  return { qualified, unqualified };
}

// -------------------- TABLE REPLACEMENT --------------------

function replaceTableAtRanges(sql, entries, mappingByRawUpper) {
  if (!entries.length) return sql;
  let out = '';
  let cursor = 0;
  for (const e of entries) {
    const replUpper = mappingByRawUpper[upper(e.raw)];
    if (!replUpper) continue;

    out += sql.slice(cursor, e.start);
    const ownerPrefix = e.owner ? `${e.owner}.` : '';
    const segment = sql.slice(e.start, e.end);
    const reSeg = new RegExp(
      `\\b(${e.keyword})\\s+(${e.owner ? e.owner + '\\.' : ''}${e.base})\\b`,
      'i',
    );
    out += segment.replace(reSeg, (_, kw) => `${kw} ${ownerPrefix}${replUpper}`);
    cursor = e.end;
  }
  out += sql.slice(cursor);
  return out || sql;
}

// -------------------- INDIVIDUAL FIXUP RULES --------------------

/**
 * Redirect phantom / misspelled table names to known tables.
 * Uses fuzzy matching (Levenshtein) and column-based heuristics.
 */
function fixTableNames(sql, tableSet, colsByTable, fuzzyThreshold) {
  if (!sql) return { sql, corrections: [] };

  const fj = parseFromJoins(sql);
  if (!fj.length) return { sql, corrections: [] };

  const { qualified, unqualified } = extractColumnUsage(sql, tableSet);
  const corrections = [];
  const mappingByRaw = {};

  for (const e of fj) {
    const baseU = upper(e.base);
    const rawU = upper(e.raw);

    if (tableSet.has(baseU) || tableSet.has(rawU)) continue;

    // 1) Fuzzy match (typo in table name)
    const fuzzy = fuzzyMatchTable(baseU, tableSet, fuzzyThreshold);
    if (fuzzy && fuzzy !== baseU) {
      corrections.push({
        type: 'TABLE_FUZZY_MATCH',
        from: e.raw,
        to: fuzzy,
        distance: levenshtein(baseU, fuzzy),
      });
      mappingByRaw[rawU] = fuzzy;
      continue;
    }

    // 2) Column-based heuristic
    const qCols = Array.from(qualified[baseU] || new Set());
    const uqCols = Array.from(unqualified);

    let best = null;
    for (const t of tableSet) {
      const cols = colsByTable[t] || new Set();
      let score = 0;
      for (const c of qCols) if (cols.has(c)) score += 2;
      for (const c of uqCols) if (cols.has(c)) score += 1;
      if (score > 0) {
        if (!best || score > best.score) best = { table: t, score };
        else if (score === best.score) best = { table: null, score };
      }
    }

    if (best && best.table) {
      corrections.push({
        type: 'TABLE_COLUMN_MATCH',
        from: e.raw,
        to: best.table,
        score: best.score,
      });
      mappingByRaw[rawU] = best.table;
    }
  }

  const fixedSql = Object.keys(mappingByRaw).length
    ? replaceTableAtRanges(sql, fj, mappingByRaw)
    : sql;

  return { sql: fixedSql, corrections };
}

/** Case-insensitive LIKE — wraps both sides in UPPER(). */
function fixCaseInsensitiveLike(sql) {
  if (!sql) return sql;

  const re =
    /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s+(NOT\s+)?LIKE\s+(:b\d+|:\w+|'[^']*'|"[^"]*")/gi;

  return sql.replace(re, (match, col, notKw = '', rhs) => {
    const leftIsUpper = /^\s*UPPER\s*\(/i.test(col);
    const rightIsUpper = /^\s*UPPER\s*\(/i.test(rhs);
    if (leftIsUpper && rightIsUpper) return match;
    const left = leftIsUpper ? col : `UPPER(${col})`;
    const right = rightIsUpper ? rhs : `UPPER(${rhs})`;
    return `${left} ${notKw || ''}LIKE ${right}`.replace(/\s+/g, ' ').trim();
  });
}

/**
 * Sanitize SELECT clause:
 * - COUNT("tablename") or COUNT(TABLENAME) → COUNT(*)
 * - SELECT TABLENAME, COUNT(*) → SELECT COUNT(*)
 */
function fixCountTable(sql) {
  if (!sql) return sql;
  let out = sql;
  out = out.replace(/\bCOUNT\s*\(\s*"?[A-Z0-9_]+"?\s*\)/gi, 'COUNT(*)');
  out = out.replace(/\bSELECT\s+("?([A-Z0-9_]+)"?\s*,\s*)+(COUNT\s*\(\s*\*\s*\))/i, 'SELECT $3');
  return out;
}

/** Fix reserved word aliases: CURRENT → CURR, PREVIOUS → PREV */
function fixReservedAliases(sql) {
  if (!sql) return sql;
  let out = String(sql);
  out = out.replace(/\bcurrent\./gi, 'CURR.');
  out = out.replace(/\bprevious\./gi, 'PREV.');
  out = out.replace(/(\bFROM|\bJOIN)\s+([A-Z0-9_."$]+)\s+current\b/gi, '$1 $2 CURR');
  out = out.replace(/(\bFROM|\bJOIN)\s+([A-Z0-9_."$]+)\s+previous\b/gi, '$1 $2 PREV');
  return out;
}

/** Fix $N positional params → :bN named binds. */
function fixPositionalBinds(sql) {
  if (!sql) return sql;
  if (/\$\d+/.test(sql) && !/:b\d+/.test(sql)) {
    return sql.replace(/\$(\d+)/g, ':b$1');
  }
  return sql;
}

/** Move aggregate functions from WHERE to HAVING. */
function fixAggregateInWhere(sql) {
  if (!sql) return sql;
  if (!/\bWHERE\b/i.test(sql) || !/\b(SUM|COUNT|AVG|MIN|MAX)\s*\(/i.test(sql)) return sql;

  const aggRe =
    /\b(AND|WHERE)\s+((SUM|COUNT|AVG|MIN|MAX)\s*\([^)]+\)\s*(?:>=?|<=?|=|!=|<>)\s*(?::?\w+|[0-9.]+))/gi;

  const aggConditions = [];
  let out = sql;
  let match;
  while ((match = aggRe.exec(sql)) !== null) {
    aggConditions.push(match[2].trim());
  }
  if (!aggConditions.length) return sql;

  for (const cond of aggConditions) {
    const escaped = cond.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('\\bAND\\s+' + escaped, 'gi'), '');
    out = out.replace(new RegExp(escaped + '\\s+AND\\b', 'gi'), '');
    out = out.replace(new RegExp('\\bWHERE\\s+' + escaped + '\\b', 'gi'), '');
  }

  out = out.replace(/\bWHERE\s+(AND\b|GROUP\b|ORDER\b|LIMIT\b|HAVING\b|FETCH\b|$)/gi, '$1');
  out = out.replace(/\bWHERE\s*$/gi, '');

  const havingClause = ' HAVING ' + aggConditions.join(' AND ');
  if (/\bHAVING\b/i.test(out)) {
    out = out.replace(/\bHAVING\b/i, havingClause + ' AND ');
  } else if (/\bORDER\s+BY\b/i.test(out)) {
    out = out.replace(/\bORDER\s+BY\b/i, havingClause + ' ORDER BY');
  } else if (/\bLIMIT\b/i.test(out)) {
    out = out.replace(/\bLIMIT\b/i, havingClause + ' LIMIT');
  } else if (/\bFETCH\b/i.test(out)) {
    out = out.replace(/\bFETCH\b/i, havingClause + ' FETCH');
  } else {
    out += havingClause;
  }

  return out;
}

/** Fix SQL keywords used as table qualifiers (WHERE.col → col). */
function fixKeywordQualifiers(sql) {
  if (!sql) return sql;
  return sql.replace(
    /\b(WHERE|JOIN|FROM|GROUP|ORDER|HAVING|SELECT|ON)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/gi,
    '$2',
  );
}

/** Remove stray semicolons (trailing or before LIMIT/FETCH). */
function fixStraySemicolons(sql) {
  if (!sql) return sql;
  let out = sql.replace(/;\s*$/, '');
  out = out.replace(/;\s*(LIMIT\b|FETCH\b)/gi, ' $1');
  return out;
}

// -------------------- PUBLIC API --------------------

/**
 * Apply all fixup rules to LLM-generated SQL.
 *
 * @param {string} sql - Raw SQL from LLM
 * @param {object} [options]
 * @param {string[]} [options.knownTables] - Known table names for fuzzy matching
 * @param {Object<string, string[]>} [options.knownColumns] - Per-table column names for heuristic matching
 * @param {number} [options.fuzzyThreshold=0.85] - Table name similarity threshold (0-1)
 * @returns {{ sql: string, corrections: Array<{type: string, from?: string, to?: string}> }}
 */
export function fixupSQL(sql, options = {}) {
  const { knownTables, knownColumns, fuzzyThreshold } = options;

  if (!sql) return { sql: '', corrections: [] };

  const corrections = [];
  let out = String(sql);

  // 1. Fuzzy table name matching
  if (knownTables && knownTables.length) {
    const { tableSet, colsByTable } = buildCatalogIndex(knownTables, knownColumns);
    const tableResult = fixTableNames(out, tableSet, colsByTable, fuzzyThreshold);
    out = tableResult.sql;
    corrections.push(...tableResult.corrections);
  }

  // 2. COUNT(table) → COUNT(*)
  const beforeCount = out;
  out = fixCountTable(out);
  if (out !== beforeCount) {
    corrections.push({ type: 'COUNT_TABLE_TO_STAR' });
  }

  // 3. Case-insensitive LIKE
  const beforeLike = out;
  out = fixCaseInsensitiveLike(out);
  if (out !== beforeLike) {
    corrections.push({ type: 'CASE_INSENSITIVE_LIKE' });
  }

  // 4. Reserved word aliases
  const beforeAlias = out;
  out = fixReservedAliases(out);
  if (out !== beforeAlias) {
    corrections.push({ type: 'RESERVED_ALIAS_FIX' });
  }

  // 5. SQL keyword as qualifier (WHERE.col → col)
  const beforeKw = out;
  out = fixKeywordQualifiers(out);
  if (out !== beforeKw) {
    corrections.push({ type: 'KEYWORD_QUALIFIER_FIX' });
  }

  // 6. Positional binds ($N → :bN)
  const beforeBinds = out;
  out = fixPositionalBinds(out);
  if (out !== beforeBinds) {
    corrections.push({ type: 'POSITIONAL_BINDS_FIX' });
  }

  // 7. Aggregate in WHERE → HAVING
  const beforeAgg = out;
  out = fixAggregateInWhere(out);
  if (out !== beforeAgg) {
    corrections.push({ type: 'AGGREGATE_WHERE_TO_HAVING' });
  }

  // 8. Stray semicolons
  const beforeSemi = out;
  out = fixStraySemicolons(out);
  if (out !== beforeSemi) {
    corrections.push({ type: 'STRAY_SEMICOLON_REMOVED' });
  }

  return { sql: out, corrections };
}
