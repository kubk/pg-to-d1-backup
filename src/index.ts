import { appendFileSync } from "node:fs";
import { backup, formatBytes } from "./backup.ts";
import { createCloudflareClient } from "./cloudflare.ts";

function input(name: string, required = false) {
  const value = process.env[`INPUT_${name.toUpperCase()}`]?.trim() ?? "";
  if (required && !value) {
    throw new Error(`Input ${name} is required`);
  }
  return value;
}

async function main() {
  const result = await backup({
    postgresUrl: input("postgres-url", true),
    database: input("d1-database", true),
    schema: input("schema") || "public",
    accountId: input("cloudflare-account-id") || undefined,
    cloudflare: createCloudflareClient(input("cloudflare-api-token", true)),
  });

  const { tables, import: imported } = result;
  console.log(
    `Backup done: ${imported.rowsWritten} rows written, database is ${formatBytes(imported.sizeBytes)}, Time Travel bookmark ${imported.bookmark}`,
  );

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `database-id=${result.databaseId}\nbookmark=${imported.bookmark}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = tables.map((t) => `| ${t.name} | ${t.rowCount} |`).join("\n");
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Postgres → D1 backup\n\n| Table | Rows |\n| --- | --: |\n${rows}\n\nD1 size ${formatBytes(imported.sizeBytes)}, Time Travel bookmark \`${imported.bookmark}\`\n`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`::error::${message.replaceAll("\n", "%0A")}`);
  process.exitCode = 1;
});
