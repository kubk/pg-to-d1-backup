# pg-to-d1-backup

GitHub Action that copies every table of a Postgres database into a [Cloudflare D1](https://developers.cloudflare.com/d1/) database. Run it on a schedule to get free off-site backups of a database that has none, such as a free Supabase project.

```yaml
name: Backup database

on:
  schedule:
    - cron: "0 17 * * 0" # weekly
  workflow_dispatch:

jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: kubk/pg-to-d1-backup@v1
        with:
          postgres-url: ${{ secrets.DATABASE_URL }}
          d1-database: my-app-backup
          cloudflare-api-token: ${{ secrets.D1_BACKUP_API_TOKEN }}
```

## How it works

1. Reads every table of the schema inside one read-only `REPEATABLE READ` transaction. The copy is a consistent snapshot and writers are never blocked.
2. Tables and columns come from `information_schema` on every run, so new tables and columns are picked up with no changes.
3. Builds one SQL file that drops the previous copy and recreates it, then loads it with the D1 import API (the same one `wrangler d1 execute --file` uses). D1 applies the import atomically: if it fails, the database stays as it was.
4. Compares row counts in D1 with what was read from Postgres and fails the job on any difference.

Every value is copied as Postgres text, which is lossless: timestamps keep microseconds, `numeric` keeps its precision, `json`/`jsonb` stays valid JSON, arrays use Postgres array syntax and `bytea` becomes `\x` hex. Integers and booleans (as `1`/`0`) are stored as SQLite integers.

The copy holds data only: no primary keys, indexes or foreign keys. A `_backup_info` table records each table's row count and the backup time.

## Restoring

Each run replaces the database, and older copies are kept by [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/): 30 days on Workers Paid, 7 days on Free. The job prints the Time Travel bookmark of every backup, and it's also the `bookmark` output.

```sh
npx wrangler d1 time-travel restore my-app-backup --timestamp 2026-01-01T00:00:00Z
npx wrangler d1 export my-app-backup --remote --output backup.sql
```

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `postgres-url` | yes | Postgres connection URL. Transaction pooler URLs (Supabase, Neon, PgBouncer) work. |
| `d1-database` | yes | D1 database name. Created on the first run if missing. |
| `cloudflare-api-token` | yes | API token with the **Account › D1 › Edit** permission. |
| `cloudflare-account-id` | no | Needed only when the token can access more than one account. |
| `schema` | no | Postgres schema to copy. Default `public`. |

Outputs: `database-id`, `bookmark`.

## Limits

D1 limits a single value to 2 MB, a table to 100 columns and a database to 10 GB (500 MB on Free). Values over 100 KB are split across several statements, so large JSON or text columns are fine. Each run writes every row, which counts toward D1's [rows written](https://developers.cloudflare.com/d1/platform/pricing/) quota: 100k per day on Free, 50M per month included on Workers Paid.

GitHub runners connect over IPv4. Supabase direct connections are IPv6-only, so use the pooler URL.

## Development

```sh
pnpm install
pnpm test                                    # Postgres tests are skipped
TEST_POSTGRES_URL=postgres://... pnpm test   # all tests
pnpm run build                               # commit dist/ with your change
```
