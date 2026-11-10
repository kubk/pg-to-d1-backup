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

Each run replaces the database, and older copies are kept by [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), so you can restore the database to an earlier point in time. The job prints the Time Travel bookmark of every backup, and it's also the `bookmark` output.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `postgres-url` | yes | Postgres connection URL. Transaction pooler URLs (Supabase, Neon, PgBouncer) work. |
| `d1-database` | yes | D1 database name. Created on the first run if missing. |
| `cloudflare-api-token` | yes | API token with the **Account › D1 › Edit** permission. |
| `cloudflare-account-id` | no | Needed only when the token can access more than one account. |
| `schema` | no | Postgres schema to copy. Default `public`. |
| `exclude-tables` | no | Tables to leave out, separated by commas or newlines, e.g. `log, notification`. Their previous copy is dropped. A name that matches no table only gives a warning. |

Outputs: `database-id`, `bookmark`.

## Limits

D1 has limits on value size, columns per table and database size, and every run writes every row, which counts toward D1's [rows written](https://developers.cloudflare.com/d1/platform/pricing/) quota. Check the current [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) before backing up a large database. Large JSON or text values are split across several statements automatically.

GitHub runners connect over IPv4. Supabase direct connections are IPv6-only, so use the pooler URL.

## Development

```sh
pnpm install
pnpm test                                    # Postgres tests are skipped
TEST_POSTGRES_URL=postgres://... pnpm test   # all tests
pnpm run build                               # commit dist/ with your change
```
