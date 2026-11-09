import postgres from "postgres";
import {
  createInsertWriter,
  createTableSql,
  quoteIdent,
  type Column,
  type Value,
} from "./sql.ts";

export type TableSummary = { name: string; rowCount: number };

const CURSOR_ROWS = 1000;

// Reads every base table of a schema inside one read-only REPEATABLE READ
// transaction: a consistent snapshot that never blocks writers. Every value is
// read as Postgres text, which is lossless (timestamps keep microseconds,
// numeric keeps precision, json stays json, bytea becomes \x hex).
export async function dumpPostgres(
  url: string,
  schema: string,
  emit: (statement: string) => void,
): Promise<TableSummary[]> {
  const sql = postgres(url, {
    // Transaction poolers (Supabase, Neon, PgBouncer) don't keep prepared statements
    prepare: false,
    fetch_types: false,
    max: 1,
    connect_timeout: 30,
    ssl: /[?&]sslmode=/.test(url) ? undefined : "prefer",
    onnotice: () => {},
  });

  try {
    return await sql.begin(
      "isolation level repeatable read read only",
      async (tx) => {
        const columnRows = (await tx.unsafe(
          `select
            c.table_name as "tableName",
            c.column_name as "columnName",
            c.data_type as "dataType"
          from information_schema.columns c
          join information_schema.tables t
            on t.table_schema = c.table_schema and t.table_name = c.table_name
          where c.table_schema = $1 and t.table_type = 'BASE TABLE'
          order by c.table_name, c.ordinal_position`,
          [schema],
        )) as unknown as {
          tableName: string;
          columnName: string;
          dataType: string;
        }[];
        if (columnRows.length === 0) {
          throw new Error(`No tables found in schema "${schema}"`);
        }

        const tables = new Map<string, Column[]>();
        for (const row of columnRows) {
          const columns = tables.get(row.tableName) ?? [];
          columns.push({ name: row.columnName, type: row.dataType });
          tables.set(row.tableName, columns);
        }

        const summary: TableSummary[] = [];
        for (const [table, columns] of tables) {
          emit(createTableSql(table, columns));
          const writer = createInsertWriter(table, columns, emit);
          const select = columns.map(selectAsText).join(", ");
          const query = tx
            .unsafe(
              `select ${select} from ${quoteIdent(schema)}.${quoteIdent(table)}`,
            )
            .values();
          let rowCount = 0;
          for await (const rows of query.cursor(CURSOR_ROWS)) {
            for (const row of rows) {
              writer.add(row as Value[]);
            }
            rowCount += rows.length;
          }
          writer.flush();
          summary.push({ name: table, rowCount });
        }
        return summary;
      },
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function selectAsText(column: Column) {
  const ident = quoteIdent(column.name);
  // Booleans become 1/0 so they read naturally in SQLite
  return column.type === "boolean" ? `${ident}::int::text` : `${ident}::text`;
}
