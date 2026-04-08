// sql-shield/src/catalog.js
// Auto-generate table/column whitelist from PostgreSQL schema introspection.
// Requires `pg` as peer dependency (optional — only needed for this module).

/**
 * Generate a whitelist of tables and columns from a PostgreSQL database.
 *
 * @param {object} options
 * @param {string} [options.host='localhost'] - PostgreSQL host
 * @param {number} [options.port=5432] - PostgreSQL port
 * @param {string} options.database - Database name
 * @param {string} [options.schema='public'] - Schema to introspect
 * @param {string} [options.user] - Database user
 * @param {string} [options.password] - Database password
 * @param {string[]} [options.excludeTables] - Tables to exclude from the whitelist
 * @param {import('pg').Pool} [options.pool] - Existing pg Pool instance (if you already have one)
 * @returns {Promise<{ tables: string[], columns: Object<string, string[]> }>}
 *
 * @example
 * import { generateWhitelist } from 'sql-shield/catalog';
 *
 * const whitelist = await generateWhitelist({
 *   database: 'my_shop',
 *   schema: 'public',
 *   excludeTables: ['migrations', 'sessions'],
 * });
 * // { tables: ['customers', 'orders', ...], columns: { customers: ['id', 'name', ...], ... } }
 */
export async function generateWhitelist(options = {}) {
  const {
    host = 'localhost',
    port = 5432,
    database,
    schema = 'public',
    user,
    password,
    excludeTables = [],
    pool: existingPool,
  } = options;

  let pg;
  try {
    pg = await import('pg');
  } catch {
    throw new Error(
      'sql-shield/catalog requires the "pg" package. Install it with: npm install pg',
    );
  }

  const Pool = pg.default?.Pool || pg.Pool;
  const pool = existingPool || new Pool({ host, port, database, user, password, max: 2 });
  const ownPool = !existingPool;

  try {
    const excludeSet = new Set(excludeTables.map((t) => t.toLowerCase()));

    // Fetch tables + views
    const tablesRes = await pool.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type IN ('BASE TABLE', 'VIEW')
        ORDER BY table_name`,
      [schema],
    );

    const tables = tablesRes.rows
      .map((r) => r.table_name)
      .filter((t) => !excludeSet.has(t.toLowerCase()));

    // Fetch columns for those tables
    const colsRes = await pool.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = $1
        ORDER BY table_name, ordinal_position`,
      [schema],
    );

    const columns = {};
    for (const row of colsRes.rows) {
      const t = row.table_name;
      if (excludeSet.has(t.toLowerCase())) continue;
      if (!columns[t]) columns[t] = [];
      columns[t].push(row.column_name);
    }

    return { tables, columns };
  } finally {
    if (ownPool) await pool.end();
  }
}
