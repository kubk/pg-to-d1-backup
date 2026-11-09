// Turns Postgres rows into SQLite statements that fit D1 limits:
// a statement is at most 100 KB, a single value at most 2 MB.

export type Column = { name: string; type: string };

export type Value = string | null;

const MAX_STATEMENT_BYTES = 90_000;
const MAX_VALUE_BYTES = 2_000_000;
// A UTF-16 unit takes at most 3 bytes in UTF-8, and a doubled quote 2 bytes
// for 1 unit, so a chunk of 25k units stays under 75 KB.
const CHUNK_UNITS = 25_000;

export function quoteIdent(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

export function sqlLiteral(value: Value) {
  return value === null ? "null" : `'${value.replaceAll("'", "''")}'`;
}

// Values arrive as Postgres text. Integer affinity turns integer-like text
// back into integers. numeric stays text to keep its precision.
export function sqliteType(postgresType: string) {
  switch (postgresType) {
    case "smallint":
    case "integer":
    case "bigint":
    case "boolean":
      return "integer";
    case "real":
    case "double precision":
      return "real";
    default:
      return "text";
  }
}

export function createTableSql(table: string, columns: Column[]) {
  const definitions = columns
    .map((column) => `${quoteIdent(column.name)} ${sqliteType(column.type)}`)
    .join(", ");
  return `create table ${quoteIdent(table)} (${definitions})`;
}

// Packs rows into multi-row inserts. A row too big for one statement is
// inserted with its largest values empty, then those values are appended
// chunk by chunk.
export function createInsertWriter(
  table: string,
  columns: Column[],
  emit: (statement: string) => void,
) {
  const tableIdent = quoteIdent(table);
  const prefix = `insert into ${tableIdent} values `;
  const prefixBytes = Buffer.byteLength(prefix);
  let tuples: string[] = [];
  let bytes = prefixBytes;

  const flush = () => {
    if (tuples.length > 0) {
      emit(prefix + tuples.join(", "));
      tuples = [];
      bytes = prefixBytes;
    }
  };

  const addOversized = (row: Value[]) => {
    const values = [...row];
    const deferred: number[] = [];
    const insert = () => `${prefix}(${values.map(sqlLiteral).join(", ")})`;
    while (Buffer.byteLength(insert()) > MAX_STATEMENT_BYTES) {
      const largest = indexOfLargest(values);
      if (largest === -1) {
        throw new Error(`Row in table ${table} can't fit a D1 statement`);
      }
      deferred.push(largest);
      values[largest] = "";
    }
    emit(insert());
    for (const index of deferred) {
      const column = quoteIdent(columns[index]!.name);
      for (const chunk of splitIntoChunks(row[index]!)) {
        emit(
          `update ${tableIdent} set ${column} = ${column} || ${sqlLiteral(chunk)} where rowid = (select max(rowid) from ${tableIdent})`,
        );
      }
    }
  };

  return {
    add(row: Value[]) {
      for (let i = 0; i < row.length; i++) {
        const value = row[i];
        if (value != null && Buffer.byteLength(value) > MAX_VALUE_BYTES) {
          throw new Error(
            `Value in ${table}.${columns[i]!.name} is over the 2 MB D1 limit`,
          );
        }
      }
      const tuple = `(${row.map(sqlLiteral).join(", ")})`;
      const tupleBytes = Buffer.byteLength(tuple);
      if (prefixBytes + tupleBytes > MAX_STATEMENT_BYTES) {
        flush();
        addOversized(row);
        return;
      }
      if (bytes + tupleBytes + 2 > MAX_STATEMENT_BYTES) {
        flush();
      }
      tuples.push(tuple);
      bytes += tupleBytes + 2;
    },
    flush,
  };
}

function indexOfLargest(values: Value[]) {
  let index = -1;
  for (let i = 0; i < values.length; i++) {
    const length = values[i]?.length ?? 0;
    if (length > 0 && (index === -1 || length > values[index]!.length)) {
      index = i;
    }
  }
  return index;
}

export function splitIntoChunks(value: string) {
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + CHUNK_UNITS, value.length);
    // Keep surrogate pairs together
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) {
      end--;
    }
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}
