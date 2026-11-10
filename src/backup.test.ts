// Needs a real Postgres: TEST_POSTGRES_URL=postgres://... pnpm test
// D1 is replaced with in-memory SQLite.
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { backup, INFO_TABLE } from "./backup.ts";
import type { CloudflareClient } from "./cloudflare.ts";

const url = process.env.TEST_POSTGRES_URL;

function fakeCloudflare(db: DatabaseSync) {
  const imports: Buffer[] = [];
  const client = {
    getOnlyAccountId: async () => "account",
    findOrCreateDatabase: async () => ({ id: "database", created: false }),
    // Like D1, runs every statement and returns all their rows
    query: async (_account: string, _database: string, sql: string) =>
      sql
        .split(/;\s*/)
        .filter(Boolean)
        .flatMap((statement) => db.prepare(statement).all()),
    importSql: async (_account: string, _database: string, file: Buffer) => {
      imports.push(file);
      db.exec("begin");
      try {
        db.exec(file.toString());
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
      return { queries: 0, rowsWritten: 0, sizeBytes: 0, bookmark: "bookmark" };
    },
  } as unknown as CloudflareClient;
  return { client, imports };
}

describe("backup", { skip: !url && "TEST_POSTGRES_URL is not set" }, () => {
  const sql = postgres(url ?? "", { max: 1, onnotice: () => {} });

  before(async () => {
    await sql.unsafe(`
      drop schema if exists backup_test cascade;
      create schema backup_test;
      create type backup_test.mood as enum ('happy', 'sad');
      create table backup_test.person (
        id uuid primary key default gen_random_uuid(),
        name text not null,
        age integer,
        balance bigint,
        price numeric(20, 10),
        ratio double precision,
        active boolean,
        mood backup_test.mood,
        tags text[],
        meta jsonb,
        avatar bytea,
        born_at timestamptz,
        "Weird ""Name""" text
      );
      create table backup_test."order" (id serial, note varchar(10));
      create view backup_test.person_view as select name from backup_test.person;
      insert into backup_test.person
        (name, age, balance, price, ratio, active, mood, tags, meta, avatar, born_at, "Weird ""Name""")
      values
        ('O''Brien', 42, 9007199254740991, 1234567890.0123456789, 0.5, true, 'happy',
         '{a,"b c"}', '{"k": [1, "two", null]}', '\\x00ff10',
         '2024-02-29 12:34:56.123456+00', 'ok'),
        ('Nobody', null, null, null, null, false, null, null, null, null, null, null),
        ('Big', 1, 1, 1, 1, true, 'sad', '{}', jsonb_build_object('text', repeat('é''', 200000)), null, now(), null);
      insert into backup_test."order" (note) select 'n' || g from generate_series(1, 2500) g;
    `);
  });

  after(async () => {
    await sql.unsafe("drop schema if exists backup_test cascade");
    await sql.end();
  });

  it("copies every table losslessly and replaces the previous copy", async () => {
    const d1 = new DatabaseSync(":memory:");
    d1.exec("create table stale (id integer); insert into stale values (1);");
    const { client } = fakeCloudflare(d1);

    const result = await backup({
      postgresUrl: url!,
      schema: "backup_test",
      database: "backup",
      cloudflare: client,
      log: () => {},
    });

    assert.deepEqual(
      result.tables.map((t) => [t.name, t.rowCount]),
      [
        ["order", 2500],
        ["person", 3],
      ],
    );
    const tables = d1
      .prepare(
        "select name from sqlite_master where type = 'table' order by name",
      )
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, [INFO_TABLE, "order", "person"]);

    const [pg] = await sql.unsafe(
      `select age, balance, price::text, ratio, mood::text, tags::text, meta::text,
        avatar::text, born_at::text, "Weird ""Name""" as weird
       from backup_test.person where name = 'O''Brien'`,
    );
    const copied = d1
      .prepare(
        `select age, balance, price, ratio, active, mood, tags, meta, avatar, born_at, "Weird ""Name""" as weird
         from person where name = 'O''Brien'`,
      )
      .get()!;
    assert.equal(copied.age, 42);
    assert.equal(copied.balance, 9007199254740991);
    assert.equal(copied.price, pg!.price);
    assert.equal(copied.ratio, 0.5);
    assert.equal(copied.active, 1);
    assert.equal(copied.mood, "happy");
    assert.equal(copied.tags, pg!.tags);
    assert.deepEqual(JSON.parse(String(copied.meta)), { k: [1, "two", null] });
    assert.equal(copied.avatar, "\\x00ff10");
    assert.equal(copied.born_at, pg!.born_at);
    assert.equal(copied.weird, "ok");

    const nobody = d1
      .prepare("select * from person where name = 'Nobody'")
      .get()!;
    assert.equal(nobody.age, null);
    assert.equal(nobody.active, 0);

    const big = d1.prepare("select meta from person where name = 'Big'").get()!;
    const [pgBig] = await sql.unsafe(
      "select meta::text as meta from backup_test.person where name = 'Big'",
    );
    assert.equal(big.meta, pgBig!.meta);

    const info = d1
      .prepare(`select table_name, row_count from ${INFO_TABLE} order by 1`)
      .all();
    assert.deepEqual(
      info.map((row) => [row.table_name, row.row_count]),
      [
        ["order", 2500],
        ["person", 3],
      ],
    );
  });

  it("leaves excluded tables out and drops their previous copy", async () => {
    const d1 = new DatabaseSync(":memory:");
    const { client } = fakeCloudflare(d1);
    const options = {
      postgresUrl: url!,
      schema: "backup_test",
      database: "backup",
      cloudflare: client,
    };
    await backup({ ...options, log: () => {} });

    const logs: string[] = [];
    const result = await backup({
      ...options,
      excludeTables: ["order", "missing"],
      log: (message) => logs.push(message),
    });

    assert.deepEqual(
      result.tables.map((t) => t.name),
      ["person"],
    );
    const tables = d1
      .prepare(
        "select name from sqlite_master where type = 'table' order by name",
      )
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, [INFO_TABLE, "person"]);
    assert.ok(
      logs.some((m) => m.startsWith("::warning::") && m.includes("missing")),
    );

    await assert.rejects(
      backup({ ...options, excludeTables: ["order", "person"], log: () => {} }),
      /Every table is excluded/,
    );
  });

  it("drops tables that no longer exist in Postgres", async () => {
    const d1 = new DatabaseSync(":memory:");
    const { client } = fakeCloudflare(d1);
    const options = {
      postgresUrl: url!,
      schema: "backup_test",
      database: "backup",
      cloudflare: client,
      log: () => {},
    };
    await backup(options);
    await sql.unsafe(`drop table backup_test."order"`);
    await backup(options);

    const tables = d1
      .prepare(
        "select name from sqlite_master where type = 'table' order by name",
      )
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, [INFO_TABLE, "person"]);
  });
});
