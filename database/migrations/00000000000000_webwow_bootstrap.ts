import type { Knex } from 'knex';

/**
 * Migration: Webwow bootstrap (Supabase compatibility layer for vanilla PostgreSQL)
 *
 * Webwow runs the UNMODIFIED upstream ycode migrations against a plain
 * PostgreSQL server. Those migrations were written for Supabase and reference
 * objects that Supabase provisions out of the box:
 *
 *   - `auth.uid()`            in every RLS policy (`(SELECT auth.uid()) IS NOT NULL`)
 *   - `auth.users`            UPDATEd by 20260527000001_bootstrap_user_roles
 *   - `storage.buckets`       INSERTed by 20250101000006_create_storage_bucket
 *   - `storage.objects`       policies are created on it by the same migration
 *   - `digest()` (pgcrypto)   used by 20260528000002_hash_mcp_refresh_tokens
 *   - roles `anon` / `authenticated` / `service_role` / `postgres`
 *                             REVOKEd / GRANTed by lib/services/migrationService.ts
 *
 * This migration sorts before every upstream migration (name starts with
 * zeros) and creates all of the above. It is deliberately idempotent
 * (IF NOT EXISTS / OR REPLACE / ADD COLUMN IF NOT EXISTS) because existing
 * Webwow installations (old fork, Supabase parts stripped from the migrations)
 * run it on a database that already has all public tables, and because the
 * Next.js runtime path (`migrationService.runMigrations`) may re-run it after a
 * partially failed setup.
 *
 * Nothing in here touches the `public` schema.
 */

/**
 * Roles that Supabase always provides and upstream SQL refers to:
 *   - anon / authenticated / service_role: REVOKEd in
 *     migrationService.ensureMigrationsTable()
 *   - postgres: GRANTed in the same function. Docker images started with
 *     POSTGRES_USER=webwow have no `postgres` role at all, and the runtime
 *     path re-creates the migrations table after a devtools "reset database".
 */
const ROLES = ['anon', 'authenticated', 'service_role', 'postgres'];

export async function up(knex: Knex): Promise<void> {
  // ---------------------------------------------------------------------------
  // 1. pgcrypto. Supabase ships it enabled; upstream relies on it:
  //      - digest(..., 'sha256') in 20260528000002_hash_mcp_refresh_tokens
  //      - gen_random_uuid() on PostgreSQL < 13 (core function since 13)
  //    pgcrypto is a "trusted" extension since PG 13, so the database owner can
  //    install it without superuser. If that still fails we abort with an
  //    actionable message instead of letting a later migration die with
  //    "function digest(...) does not exist".
  // ---------------------------------------------------------------------------
  await knex.raw(`
    DO $$
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'webwow bootstrap: extension "pgcrypto" is required (digest() is used by upstream migration 20260528000002) but could not be created: %. Ask a superuser to run: CREATE EXTENSION pgcrypto;', SQLERRM
        USING ERRCODE = SQLSTATE;
    END
    $$;
  `);

  // ---------------------------------------------------------------------------
  // 2. Supabase roles (see ROLES above). Roles are cluster-wide, so create
  //    them only if missing. NOLOGIN: they are placeholders so that
  //    GRANT/REVOKE statements written for Supabase do not fail. CREATE ROLE
  //    needs CREATEROLE (or superuser); when the migration user lacks it we
  //    log a NOTICE and go on — no upstream *migration* references these
  //    roles, only migrationService.ensureMigrationsTable() does.
  // ---------------------------------------------------------------------------
  await knex.raw(`
    DO $$
    DECLARE
      role_name text;
    BEGIN
      FOREACH role_name IN ARRAY ARRAY[${ROLES.map((r) => `'${r}'`).join(', ')}] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
          BEGIN
            EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT', role_name);
          EXCEPTION
            WHEN duplicate_object THEN
              NULL; -- created concurrently, fine
            WHEN insufficient_privilege THEN
              RAISE NOTICE 'webwow bootstrap: cannot create role % (insufficient privilege, CREATEROLE required). Continuing without it.', role_name;
          END;
        END IF;
      END LOOP;
    END
    $$;
  `);

  // ---------------------------------------------------------------------------
  // 3. Schemas
  // ---------------------------------------------------------------------------
  await knex.raw('CREATE SCHEMA IF NOT EXISTS auth');
  await knex.raw('CREATE SCHEMA IF NOT EXISTS storage');

  // ---------------------------------------------------------------------------
  // 4. auth.users — same column names Supabase GoTrue uses, so upstream code
  //    (and 20260527000001_bootstrap_user_roles) works unmodified.
  //    lib/webwow/auth-server.ts stores scrypt hashes in encrypted_password.
  // ---------------------------------------------------------------------------
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      encrypted_password text,
      raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      email_confirmed_at timestamptz,
      last_sign_in_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    )
  `);

  // Self-heal a pre-existing table that is missing columns (e.g. created by an
  // earlier hand-rolled schema). No-op on a table this migration created.
  await knex.raw(`
    ALTER TABLE auth.users
      ADD COLUMN IF NOT EXISTS email text,
      ADD COLUMN IF NOT EXISTS encrypted_password text,
      ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
      ADD COLUMN IF NOT EXISTS last_sign_in_at timestamptz,
      ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
      ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()
  `);

  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON auth.users (email)');

  // ---------------------------------------------------------------------------
  // 5. auth.* helper functions used by the upstream RLS policies.
  //    They mirror Supabase's implementation (read the request.jwt.* GUCs) but
  //    Webwow never sets those, so they resolve to: uid() = NULL,
  //    role() = 'authenticated', jwt() = '{}'. Webwow connects as the table
  //    owner, which bypasses RLS anyway (upstream only ENABLEs, never FORCEs it).
  // ---------------------------------------------------------------------------
  await knex.raw(`
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $fn$
      SELECT nullif(
        coalesce(
          current_setting('request.jwt.claim.sub', true),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        ),
        ''
      )::uuid
    $fn$;
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text
    LANGUAGE sql STABLE
    AS $fn$
      SELECT coalesce(
        nullif(current_setting('request.jwt.claim.role', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
        'authenticated'
      )::text
    $fn$;
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
    LANGUAGE sql STABLE
    AS $fn$
      SELECT coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), ''),
        '{}'
      )::jsonb
    $fn$;
  `);

  // ---------------------------------------------------------------------------
  // 6. storage.buckets / storage.objects — the subset of Supabase Storage's
  //    schema that upstream references. Files themselves live on disk
  //    (UPLOAD_DIR); these tables exist so the bucket INSERT and the policies
  //    of 20250101000006_create_storage_bucket succeed.
  // ---------------------------------------------------------------------------
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS storage.buckets (
      id text PRIMARY KEY,
      name text,
      public boolean DEFAULT false,
      file_size_limit bigint,
      allowed_mime_types text[],
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    )
  `);

  await knex.raw(`
    ALTER TABLE storage.buckets
      ADD COLUMN IF NOT EXISTS name text,
      ADD COLUMN IF NOT EXISTS public boolean DEFAULT false,
      ADD COLUMN IF NOT EXISTS file_size_limit bigint,
      ADD COLUMN IF NOT EXISTS allowed_mime_types text[],
      ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
      ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bucket_id text,
      name text,
      owner uuid,
      metadata jsonb,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      last_accessed_at timestamptz DEFAULT now()
    )
  `);

  await knex.raw(`
    ALTER TABLE storage.objects
      ADD COLUMN IF NOT EXISTS bucket_id text,
      ADD COLUMN IF NOT EXISTS name text,
      ADD COLUMN IF NOT EXISTS owner uuid,
      ADD COLUMN IF NOT EXISTS metadata jsonb,
      ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
      ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now(),
      ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz DEFAULT now()
  `);

  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS bucketid_objname ON storage.objects (bucket_id, name)');

  // Supabase has RLS on storage.objects; the upstream policies expect that.
  await knex.raw('ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY');
}

export async function down(knex: Knex): Promise<void> {
  // Drop only what `up` created. Public tables are never touched.
  // CASCADE on the functions removes RLS policies that still reference
  // auth.uid() — by the time this runs in a full rollback those tables are
  // already gone; in a partial rollback only policies (never tables) go.
  await knex.raw('DROP TABLE IF EXISTS storage.objects CASCADE');
  await knex.raw('DROP TABLE IF EXISTS storage.buckets CASCADE');
  await knex.raw('DROP FUNCTION IF EXISTS auth.jwt() CASCADE');
  await knex.raw('DROP FUNCTION IF EXISTS auth.role() CASCADE');
  await knex.raw('DROP FUNCTION IF EXISTS auth.uid() CASCADE');
  await knex.raw('DROP TABLE IF EXISTS auth.users CASCADE');

  // Remove the schemas only when nothing else lives in them (they may
  // pre-exist with foreign objects, e.g. on a shared server).
  await knex.raw(`
    DO $$
    DECLARE
      schema_name text;
    BEGIN
      FOREACH schema_name IN ARRAY ARRAY['storage', 'auth'] LOOP
        BEGIN
          EXECUTE format('DROP SCHEMA IF EXISTS %I', schema_name);
        EXCEPTION WHEN dependent_objects_still_exist THEN
          RAISE NOTICE 'webwow bootstrap: schema % still contains foreign objects, leaving it in place.', schema_name;
        END;
      END LOOP;
    END
    $$;
  `);

  // Roles (anon / authenticated / service_role) are cluster-wide, NOLOGIN and
  // may be used by other databases on the same server — intentionally kept.
}
