import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createInsertWriter,
  createTableSql,
  splitIntoChunks,
  type Column,
  type Value,
} from "./sql.ts";

function roundTrip(columns: Column[], rows: Value[][]) {
  const statements: string[] = [];
  statements.push(createTableSql("t", columns));
  const writer = createInsertWriter("t", columns, (s) => statements.push(s));
  rows.forEach((row) => writer.add(row));
  writer.flush();

  for (const statement of statements) {
    assert.ok(
      Buffer.byteLength(statement) <= 100_000,
      `statement of ${Buffer.byteLength(statement)} bytes is over the D1 limit`,
    );
  }

  const db = new DatabaseSync(":memory:");
  db.exec(statements.join(";\n") + ";");
  const stored = db
    .prepare("select * from t order by rowid")
    .all()
    .map((row) => Object.values(row));
  return { statements, stored };
}

const textColumns = (n: number): Column[] =>
  Array.from({ length: n }, (_, i) => ({ name: `c${i}`, type: "text" }));

describe("createInsertWriter", () => {
  it("keeps quotes, newlines, unicode, nulls and empty strings", () => {
    const rows: Value[][] = [
      ["it's", "a\nb; c", "日本語 🚀", null],
      ["", "'; drop table t; --", '"quoted"', "\\x00ff"],
    ];
    const { stored } = roundTrip(textColumns(4), rows);
    assert.deepEqual(stored, rows);
  });

  it("packs small rows into few statements", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => [String(i), "row"]);
    const { statements, stored } = roundTrip(textColumns(2), rows);
    assert.equal(stored.length, 5000);
    assert.ok(statements.length < 10, `got ${statements.length} statements`);
  });

  it("splits values larger than a statement", () => {
    const big = "x'y🚀".repeat(80_000); // ~640 KB, with quotes and surrogates
    const rows: Value[][] = [
      ["before", "small"],
      ["huge", big],
      ["after", "small"],
    ];
    const { stored } = roundTrip(textColumns(2), rows);
    assert.deepEqual(stored, rows);
  });

  it("splits rows made of many medium values", () => {
    const row = Array.from({ length: 40 }, (_, i) => `${i}`.repeat(5_000));
    const { stored } = roundTrip(textColumns(40), [row, row]);
    assert.deepEqual(stored, [row, row]);
  });

  it("keeps integer affinity for integer columns", () => {
    const columns: Column[] = [
      { name: "id", type: "bigint" },
      { name: "flag", type: "boolean" },
      { name: "price", type: "numeric" },
    ];
    const { stored } = roundTrip(columns, [["123456789012", "1", "0.10"]]);
    assert.deepEqual(stored, [[123456789012, 1, "0.10"]]);
  });

  it("rejects a value over the 2 MB D1 limit", () => {
    const writer = createInsertWriter("t", textColumns(1), () => {});
    assert.throws(() => writer.add(["x".repeat(2_000_001)]), /2 MB/);
  });
});

describe("splitIntoChunks", () => {
  it("never splits a surrogate pair", () => {
    const value = "a" + "🚀".repeat(30_000);
    const chunks = splitIntoChunks(value);
    assert.equal(chunks.join(""), value);
    for (const chunk of chunks) {
      assert.ok(!/[\ud800-\udbff]$/.test(chunk));
      assert.ok(!/^[\udc00-\udfff]/.test(chunk));
    }
  });
});
