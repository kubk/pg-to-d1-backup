import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCloudflareClient } from "./cloudflare.ts";

type Call = { method: string; url: string; body: unknown };

function fakeFetch(responses: ((call: Call) => Response)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    const body =
      typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const call = { method: init.method ?? "GET", url: String(url), body };
    calls.push(call);
    const next = responses.shift();
    assert.ok(next, `unexpected request ${call.method} ${call.url}`);
    return next(call);
  }) as typeof fetch;
  return { fn, calls };
}

const ok = (result: unknown) => () =>
  Response.json({ success: true, errors: [], result });

describe("importSql", () => {
  const file = Buffer.from("create table t (a text);");
  const etag = createHash("md5").update(file).digest("hex");
  const complete = {
    success: true,
    status: "complete",
    result: {
      num_queries: 1,
      final_bookmark: "bookmark-2",
      meta: { rows_written: 3, size_after: 4096 },
    },
  };

  it("uploads, ingests and polls until complete", async () => {
    const { fn, calls } = fakeFetch([
      ok({
        success: true,
        upload_url: "https://upload.example.com/f",
        filename: "f",
      }),
      () => new Response(null, { status: 200, headers: { etag: `"${etag}"` } }),
      ok({ success: true, status: "active", at_bookmark: "bookmark-1" }),
      ok(complete),
    ]);
    const client = createCloudflareClient("token", fn);
    const result = await client.importSql("acc", "db", file, 0);

    assert.deepEqual(result, {
      queries: 1,
      rowsWritten: 3,
      sizeBytes: 4096,
      bookmark: "bookmark-2",
    });
    assert.deepEqual(
      calls.map((c) => [c.method, (c.body as { action?: string })?.action]),
      [
        ["POST", "init"],
        ["PUT", undefined],
        ["POST", "ingest"],
        ["POST", "poll"],
      ],
    );
    assert.deepEqual(calls[3]!.body, {
      action: "poll",
      current_bookmark: "bookmark-1",
    });
  });

  it("fails on an etag mismatch", async () => {
    const { fn } = fakeFetch([
      ok({
        success: true,
        upload_url: "https://upload.example.com/f",
        filename: "f",
      }),
      () => new Response(null, { status: 200, headers: { etag: '"other"' } }),
    ]);
    const client = createCloudflareClient("token", fn);
    await assert.rejects(client.importSql("acc", "db", file, 0), /etag/);
  });

  it("reports import errors", async () => {
    const { fn } = fakeFetch([
      ok({
        success: true,
        status: "error",
        errors: ['near "x": syntax error'],
      }),
    ]);
    const client = createCloudflareClient("token", fn);
    await assert.rejects(
      client.importSql("acc", "db", file, 0),
      /syntax error/,
    );
  });
});

describe("API errors", () => {
  it("includes Cloudflare's message and hides the account ID", async () => {
    const { fn } = fakeFetch([
      () =>
        Response.json(
          {
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
          },
          { status: 403 },
        ),
    ]);
    const client = createCloudflareClient("token", fn);
    await assert.rejects(
      client.findOrCreateDatabase("secret-account", "backup"),
      (error: Error) =>
        /Authentication error/.test(error.message) &&
        !error.message.includes("secret-account"),
    );
  });
});

describe("findOrCreateDatabase", () => {
  it("uses an exact name match", async () => {
    const { fn } = fakeFetch([
      ok([
        { uuid: "1", name: "backup-old" },
        { uuid: "2", name: "backup" },
      ]),
    ]);
    const client = createCloudflareClient("token", fn);
    assert.deepEqual(await client.findOrCreateDatabase("acc", "backup"), {
      id: "2",
      created: false,
    });
  });

  it("creates the database when missing", async () => {
    const { fn, calls } = fakeFetch([
      ok([{ uuid: "1", name: "backup-old" }]),
      ok({ uuid: "3" }),
    ]);
    const client = createCloudflareClient("token", fn);
    assert.deepEqual(await client.findOrCreateDatabase("acc", "backup"), {
      id: "3",
      created: true,
    });
    assert.deepEqual(calls[1]!.body, { name: "backup" });
  });
});
