import { createHash } from "node:crypto";

const API_URL = "https://api.cloudflare.com/client/v4";

type Envelope<T> = {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
};

type QueryResult<Row> = { results: Row[]; success: boolean }[];

type ImportStatus = {
  success: boolean;
  status?: "active" | "complete" | "error";
  error?: string;
  errors?: string[];
  messages?: string[];
  at_bookmark?: string;
  upload_url?: string;
  filename?: string;
  result?: {
    num_queries: number;
    final_bookmark: string;
    meta: { rows_written: number; size_after: number };
  };
};

export type ImportResult = {
  queries: number;
  rowsWritten: number;
  sizeBytes: number;
  bookmark: string;
};

export function createCloudflareClient(
  apiToken: string,
  fetchFn: typeof fetch = fetch,
) {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchFn(API_URL + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    });
    const text = await response.text();
    let body: Envelope<T> | undefined;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON, reported below
    }
    if (!response.ok || !body?.success) {
      const reason =
        body?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ||
        text.slice(0, 500);
      throw new Error(
        `Cloudflare API ${init.method ?? "GET"} ${path.replace(/\/accounts\/[^/]+/, "/accounts/…")} failed (${response.status}): ${reason}`,
      );
    }
    return body.result;
  }

  return {
    async getOnlyAccountId() {
      const accounts = await call<{ id: string; name: string }[]>("/accounts");
      if (accounts.length !== 1) {
        throw new Error(
          `The API token can access ${accounts.length} accounts, set cloudflare-account-id`,
        );
      }
      return accounts[0]!.id;
    },

    async findOrCreateDatabase(accountId: string, name: string) {
      const found = await call<{ uuid: string; name: string }[]>(
        `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}`,
      );
      const existing = found.find((db) => db.name === name);
      if (existing) {
        return { id: existing.uuid, created: false };
      }
      const created = await call<{ uuid: string }>(
        `/accounts/${accountId}/d1/database`,
        { method: "POST", body: JSON.stringify({ name }) },
      );
      return { id: created.uuid, created: true };
    },

    async query<Row>(accountId: string, databaseId: string, sql: string) {
      const result = await call<QueryResult<Row>>(
        `/accounts/${accountId}/d1/database/${databaseId}/query`,
        { method: "POST", body: JSON.stringify({ sql }) },
      );
      return result.flatMap((statement) => statement.results);
    },

    // Same flow as `wrangler d1 execute --remote --file`. D1 applies the file
    // atomically: if it fails, the database returns to its previous state.
    async importSql(
      accountId: string,
      databaseId: string,
      file: Buffer,
      pollIntervalMs = 1000,
    ): Promise<ImportResult> {
      const path = `/accounts/${accountId}/d1/database/${databaseId}/import`;
      const post = (body: object) =>
        call<ImportStatus>(path, {
          method: "POST",
          body: JSON.stringify(body),
        });

      const etag = createHash("md5").update(file).digest("hex");
      let status = await post({ action: "init", etag });

      if (status.upload_url && status.filename) {
        const upload = await fetchFn(status.upload_url, {
          method: "PUT",
          headers: { "Content-Length": String(file.byteLength) },
          body: new Uint8Array(file),
        });
        if (upload.status !== 200) {
          throw new Error(
            `D1 import upload failed (${upload.status}): ${(await upload.text()).slice(0, 500)}`,
          );
        }
        const uploadedEtag = upload.headers.get("etag")?.replace(/^"|"$/g, "");
        if (uploadedEtag !== etag) {
          throw new Error("D1 import upload was corrupted (etag mismatch)");
        }
        status = await post({
          action: "ingest",
          etag,
          filename: status.filename,
        });
      }

      while (true) {
        if (!status.success) {
          throw new Error(
            `D1 import failed: ${status.error ?? "unknown error"}`,
          );
        }
        for (const message of status.messages ?? []) {
          console.log(message);
        }
        if (status.status === "complete" && status.result) {
          return {
            queries: status.result.num_queries,
            rowsWritten: status.result.meta.rows_written,
            sizeBytes: status.result.meta.size_after,
            bookmark: status.result.final_bookmark,
          };
        }
        if (status.status === "error") {
          throw new Error(
            `D1 import failed: ${status.errors?.join("; ") ?? status.error ?? "unknown error"}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        status = await post({
          action: "poll",
          current_bookmark: status.at_bookmark,
        });
      }
    },
  };
}

export type CloudflareClient = ReturnType<typeof createCloudflareClient>;
