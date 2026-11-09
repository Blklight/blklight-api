import type postgres from 'postgres';

interface ForeignKey {
  child_table: string;
  child_column: string;
  parent_column: string;
}

const MAX_DEPTH = 25;

/**
 * Hard-delete rows and everything that references them, children first,
 * following the foreign keys declared in the database. Integration suites use
 * it to remove a run's fixtures without hand-maintaining a table order that
 * breaks whenever a new table points at users, profiles or documents.
 * @param sql - postgres.js client
 * @param table - Table holding the root rows
 * @param column - Column matched against `values`
 * @param values - Values identifying the root rows
 */
export async function purgeRows(
  sql: postgres.Sql,
  table: string,
  column: string,
  values: string[],
  depth = 0
): Promise<void> {
  if (values.length === 0) return;
  if (depth > MAX_DEPTH) throw new Error(`purgeRows: foreign key chain deeper than ${MAX_DEPTH} at ${table}`);

  const references = await sql<ForeignKey[]>`
    SELECT kcu.table_name AS child_table, kcu.column_name AS child_column, ccu.column_name AS parent_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = ${table}
  `;

  for (const ref of references) {
    const parentKeys = await sql.unsafe<{ key: string }[]>(
      `SELECT DISTINCT "${ref.parent_column}"::text AS key FROM "${table}" WHERE "${column}"::text = ANY($1)`,
      [values]
    );
    const keys = parentKeys.map((row) => row.key).filter((key) => key !== null);
    if (ref.child_table === table && ref.child_column === column) continue;
    await purgeRows(sql, ref.child_table, ref.child_column, keys, depth + 1);
  }

  await sql.unsafe(`DELETE FROM "${table}" WHERE "${column}"::text = ANY($1)`, [values]);
}
