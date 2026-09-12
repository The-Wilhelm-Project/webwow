# Database migrations

Webwow runs the **unmodified upstream ycode migrations** in `migrations/` against a
plain PostgreSQL 16 server (no Supabase). Two Webwow-only migrations wrap them:

| File | Purpose |
|---|---|
| `migrations/00000000000000_webwow_bootstrap.ts` | Sorts first. Creates everything the upstream migrations expect Supabase to provide. |
| `migrations/99999999999999_webwow_defaults.ts` | Sorts last. Sets Webwow whitelabel defaults in `settings`. |

Both are idempotent and safe to re-run (fresh database, existing Webwow installation,
and the template-apply / project-import replay path that re-executes `up()` outside knex's
tracking).

## What the bootstrap creates

Inventory of what upstream references from Supabase (grep of `migrations/` and
`lib/services/migrationService.ts`):

| Needed by upstream | Created by the bootstrap |
|---|---|
| `auth.uid()` in every RLS policy | `auth.uid()` (uuid, STABLE), plus `auth.role()` and `auth.jwt()`. They read Supabase's `request.jwt.*` GUCs, which Webwow never sets, so they resolve to `NULL`, `'authenticated'` and `'{}'`. Webwow connects as the table owner, which bypasses RLS (upstream only `ENABLE`s it). |
| `UPDATE auth.users` (20260527000001) and Webwow's own auth | table `auth.users` (`id`, `email` unique, `encrypted_password`, `raw_app_meta_data`, `raw_user_meta_data`, `email_confirmed_at`, `last_sign_in_at`, `created_at`, `updated_at`) |
| `INSERT INTO storage.buckets` and `CREATE POLICY ... ON storage.objects` (20250101000006) | tables `storage.buckets` and `storage.objects` (RLS enabled). Files themselves live on disk under `UPLOAD_DIR`. |
| `digest(..., 'sha256')` (20260528000002) | extension `pgcrypto` (trusted since PG 13, so the database owner can install it; the migration aborts with an explicit message otherwise) |
| `REVOKE ... FROM anon / authenticated` and `GRANT ... TO postgres` in `migrationService.ensureMigrationsTable()` | roles `anon`, `authenticated`, `service_role`, `postgres` — `NOLOGIN`, created only when missing. Creating roles needs `CREATEROLE`; without it a `NOTICE` is logged and the migration continues (no migration itself depends on the roles). |

`down` drops only those objects (never anything in `public`). Roles and the `pgcrypto`
extension are cluster-/database-wide infrastructure and are intentionally left in place.

## Running migrations

Always through the knex CLI, which is what `docker-entrypoint.sh` does before starting
the app:

```sh
DATABASE_URL=postgresql://user:pass@host:5432/dbname npx knex migrate:latest --knexfile knexfile.ts
# or: npm run migrate:latest / migrate:rollback / migrate:status
```

**On a brand-new database the CLI path must run first.** The in-app path
(`lib/services/migrationService.ts`, used by the setup wizard and
`/ycode/api/devtools/run-migrations`) creates the `migrations` table itself and then runs
`REVOKE ... FROM anon` / `GRANT ... TO postgres` — before any migration, i.e. before the
bootstrap could have created those roles. After the CLI has run once, the roles exist and
the `migrations` table is present, so the in-app path (including re-migrating after a
devtools "reset database") works.

## Upgrading an installation of the old Webwow fork

Nothing special: the old migration names are all still present, so knex only runs the
bootstrap, the upstream migrations added after March 2026 and the defaults migration.
The defaults migration removes the old `webwow_badge` key (the code reads `ycode_badge`)
and renames `webwow_version` to `ycode_version`.

## Whitelabel defaults (`99999999999999_webwow_defaults.ts`)

- `ycode_badge` is set to `false` (insert or update).
- `site_name` is changed from upstream's `'Ycode Site'` to `'My Site'`, and
  `site_description` from `'Built with Ycode'` to `''` — only while they still hold the
  upstream value.

Because template apply and project import replay every migration newer than the template's
recorded version, this migration is replayed after each of them and re-applies the
whitelabel defaults.
