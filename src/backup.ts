import { dumpPostgres, type TableSummary } from "./postgres.ts";
import { quoteIdent, sqlLiteral } from "./sql.ts";
import type { CloudflareClient, ImportResult } from "./cloudflare.ts";

export const INFO_TABLE = "_backup_info";

export type BackupOptions = {
  postgresUrl: string;
  schema: string;
  database: string;
  accountId?: string;
  cloudflare: CloudflareClient;
  // Postgres tables to leave out of the copy
  excludeTables?: string[];
  log?: (message: string) => void;
};

export type BackupResult = {
  databaseId: string;
  tables: TableSummary[];
  import: ImportResult;
};

// Replaces the whole D1 database with a copy of the Postgres schema.
// Older copies are available through D1 Time Travel.
export async function backup(options: BackupOptions): Promise<BackupResult> {
  const { cloudflare, log = console.log } = options;

  const accountId = options.accountId || (await cloudflare.getOnlyAccountId());
  const database = await cloudflare.findOrCreateDatabase(
    accountId,
    options.database,
  );
  log(
    database.created
      ? `Created D1 database ${options.database}`
      : `Using D1 database ${options.database}`,
  );

  const existingTables = await cloudflare.query<{ name: string }>(
    accountId,
    database.id,
    "select name from sqlite_master where type = 'table' and name not like 'sqlite\\_%' escape '\\' and name not like '\\_cf\\_%' escape '\\'",
  );

  const statements = [
    `drop table if exists ${quoteIdent(INFO_TABLE)}`,
    ...existingTables
      .filter((table) => table.name !== INFO_TABLE)
      .map((table) => `drop table ${quoteIdent(table.name)}`),
  ];
  const excludeTables = options.excludeTables ?? [];
  const { tables, unknownExcluded } = await dumpPostgres(
    options.postgresUrl,
    options.schema,
    (statement) => statements.push(statement),
    excludeTables,
  );
  if (unknownExcluded.length > 0) {
    log(
      `::warning::Excluded tables not found in schema "${options.schema}": ${unknownExcluded.join(", ")}`,
    );
  }
  if (tables.length === 0) {
    throw new Error("Every table is excluded, nothing to back up");
  }
  const backedUpAt = new Date().toISOString();
  statements.push(
    `create table ${quoteIdent(INFO_TABLE)} (table_name text, row_count integer, backed_up_at text)`,
    `insert into ${quoteIdent(INFO_TABLE)} values ${tables
      .map(
        (t) =>
          `(${sqlLiteral(t.name)}, ${t.rowCount}, ${sqlLiteral(backedUpAt)})`,
      )
      .join(", ")}`,
  );

  const file = Buffer.from(statements.join(";\n") + ";\n");
  const rowCount = tables.reduce((sum, t) => sum + t.rowCount, 0);
  log(
    `Read ${tables.length} tables, ${rowCount} rows from Postgres, importing ${formatBytes(file.byteLength)} of SQL`,
  );

  const imported = await cloudflare.importSql(accountId, database.id, file);
  await verifyRowCounts(cloudflare, accountId, database.id, tables);

  return { databaseId: database.id, tables, import: imported };
}

async function verifyRowCounts(
  cloudflare: CloudflareClient,
  accountId: string,
  databaseId: string,
  tables: TableSummary[],
) {
  const counts = await cloudflare.query<{ name: string; count: number }>(
    accountId,
    databaseId,
    tables
      .map(
        (t) =>
          `select ${sqlLiteral(t.name)} as name, count(*) as count from ${quoteIdent(t.name)}`,
      )
      // D1 caps compound selects at a few terms, so one statement per table
      .join("; "),
  );
  const actual = new Map(counts.map((row) => [row.name, row.count]));
  const mismatches = tables.filter((t) => actual.get(t.name) !== t.rowCount);
  if (mismatches.length > 0) {
    throw new Error(
      `Row counts differ after import: ${mismatches
        .map(
          (t) => `${t.name} (postgres ${t.rowCount}, d1 ${actual.get(t.name)})`,
        )
        .join(", ")}`,
    );
  }
}

export function formatBytes(bytes: number) {
  return bytes >= 1e6
    ? `${(bytes / 1e6).toFixed(1)} MB`
    : `${(bytes / 1e3).toFixed(1)} KB`;
}
