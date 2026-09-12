# Webwow-Architektur (Überblick)

Webwow = unveränderter ycode-Code (1.30.x) + eine dünne Kompatibilitätsschicht, die Supabase durch
PostgreSQL und lokale Dateien ersetzt, + Docker-Deployment + Webflow-ZIP-Importer. Wie Upstream-Updates
eingespielt werden: [UPSTREAM-SYNC.md](UPSTREAM-SYNC.md).

```
Browser ──► proxy.ts (Cookie-Check, Security-Header) ──► Next.js Route Handler / Server Components
                                                              │
                        Upstream-Code (Repositories, Services, Routen) — unverändert
                                                              │
                             lib/supabase-server.ts · lib/supabase-auth.ts · lib/supabase-route-client.ts
                             lib/supabase-browser.ts · lib/credentials.ts · knexfile.ts   ← Nahtstellen
                                                              │
                                                       lib/webwow/**  (Shim)
                                  ┌───────────────────────────┼──────────────────────────┐
                            PostgREST-Shim               Storage (Disk)              Auth (auth.users)
                        (knex Query-Builder,           UPLOAD_DIR/<bucket>/…        HMAC-Cookie
                         rpc, jsonb-Handling)          + /storage/v1/…-Route        webwow_session
                                  └───────────────────────────┼──────────────────────────┘
                                                        PostgreSQL (DATABASE_URL)
```

## Die Schicht in einem Absatz

Der Upstream-Code ruft überall `getSupabaseAdmin()`, `getAuthUser()`, `createRouteClient()` und im
Browser `createBrowserClient()` auf. Webwow liefert unter diesen Namen Objekte mit derselben
Oberfläche wie `@supabase/supabase-js`: `from(table).select(...).eq(...)` wird in
`lib/webwow/postgrest.ts` in knex-Queries übersetzt (inkl. eingebetteter Selects wie
`page_layers!inner(...)`, `count: 'exact'`, `upsert(onConflict)`, Fehlercodes `PGRST116`/`23505`),
`storage.from(bucket)` schreibt und liest Dateien auf der Platte, `auth.*` arbeitet mit einer eigenen
`auth.users`-Tabelle und einem signierten Cookie, `channel()` ist ein No-op. `lib/credentials.ts`
meldet immer "Supabase ist konfiguriert" (synthetisiert aus `DATABASE_URL`), damit der Setup-Wizard
von Upstream übersprungen wird. Die Typen kommen weiterhin aus `@supabase/supabase-js`, deshalb
kompiliert der Upstream-Code unverändert.

## Request- und Auth-Flow

1. **`proxy.ts`** (Next.js Proxy/Middleware, Upstream-Struktur): Für `/ycode/api/*` prüft
   `verifyApiAuth` den Cookie `webwow_session` per Web-Crypto-HMAC (Secret `PAGE_AUTH_SECRET`,
   Fallback `AUTH_SECRET`). Öffentlich sind Upstreams `PUBLIC_API_PREFIXES` (`/ycode/api/setup/`,
   `/ycode/api/v1/`, Form-Submissions …) plus `/ycode/api/webwow/auth/`. Alles Weitere
   (Security-Header, Pagination-Rewrite, MCP-Bypass) ist Upstream.
2. **Login:** Browser-Shim `lib/supabase-browser.ts` → `POST /ycode/api/webwow/auth/login`
   (`signInWithPassword`) → `lib/webwow/auth-server.ts` prüft `encrypted_password`
   (`scrypt$<salt>$<hash>`) in `auth.users` und setzt den Cookie
   `webwow_session = base64url({uid, iat, exp}) + '.' + HMAC-SHA256` (`httpOnly`, `sameSite=lax`,
   `secure` nach Request-Protokoll bzw. `WEBWOW_SECURE_COOKIES`). Session-/User-Objekte werden im Supabase-Format synthetisiert.
3. **Env-Bootstrap:** Ist `ADMIN_PASSWORD` gesetzt und `auth.users` leer, legt der erste Login/
   Status-Check den Owner `ADMIN_EMAIL` an. Das Env-Passwort gilt für dieses Konto immer
   (Recovery). Ohne `ADMIN_PASSWORD` legt der Upstream-Welcome-Wizard (`signUp`) den Owner an.
4. **Route Handler:** Upstream ruft `getAuthUser()` (`lib/supabase-auth.ts`) → Cookie mit Node-Crypto
   prüfen, Benutzer aus `auth.users` laden, `{ user, client }` zurückgeben. Rollen stehen in
   `raw_app_meta_data.role` (`owner | admin | designer | editor`).
5. **Admin-API:** `auth.admin.listUsers/getUserById/updateUserById/deleteUser` arbeiten auf
   `auth.users`; `inviteUserByEmail` liefert einen erklärenden Fehler (keine Mail-Einladungen).

## Datenbank-Pool

Der Shim nutzt einen **eigenen knex-Pool** (`lib/webwow/db.ts`, auf `globalThis`), nicht den aus
`lib/knex-client.ts`: Upstream behandelt letzteren als kurzlebigen Migrations-/Template-Client und
ruft nach Projekt-Import/-Export `closeKnexClient()` (Pool destroy) auf. pg-Typparser sind so gesetzt,
dass Zeilen wie PostgREST-Antworten aussehen (Timestamps als ISO-Strings, `int8`/`numeric` als Zahlen).

## Storage-Pfade

| Was | Wo |
|---|---|
| Dateiablage | `UPLOAD_DIR/<bucket>/<storage_path>` — Bucket ist immer `assets`; Default `./uploads`, im Docker `/app/uploads` (Volume `uploads`) |
| Legacy-Fallback (Fork 0.9) | `UPLOAD_DIR/<storage_path>` wird beim Lesen weiterhin gefunden |
| Öffentliche URL | `/storage/v1/object/public/<bucket>/<pfad>` (relativ, portabel) — ausgeliefert von `app/storage/v1/object/public/[bucket]/[...path]/route.ts` (GET, Range, `immutable`-Cache) |
| Serverseitiges `fetch()` solcher URLs | `lib/webwow/fetch-intercept.ts` (installiert über `instrumentation.ts`-Pfad) liest direkt von der Platte — nötig für `app/a/[hash]` und den statischen Export |
| Signierte Uploads | `createSignedUploadUrl(path)` → `PUT /ycode/api/webwow/storage/upload?token=<HMAC({path, exp})>` |
| Upstream-Daten mit `process.cwd()` | `storage/fonts/google-fonts.json`, `storage/collections/*` (Beispiel-CMS), `public/ycode/layouts/*`, `lib/templates/layouts.ts` — deshalb kopiert das Dockerfile `storage/`, `public/` und `lib/` |

## Migrationen (Reihenfolge)

Alle liegen in `database/migrations`, Tabelle `migrations`, ausgeführt von der knex-CLI
(`npm run migrate:latest`, `docker-entrypoint.sh`) oder vom Upstream-Setup-Endpunkt
`POST /ycode/api/setup/migrate` (`lib/services/migrationService`). knex sortiert nach Dateiname:

1. `00000000000000_webwow_bootstrap.ts` — läuft auf einer nackten PostgreSQL zuerst: Schemata
   `auth`, `storage`; Rollen `anon`, `authenticated`, `service_role` (NOLOGIN, nur falls fehlend);
   Tabelle `auth.users`; Funktionen `auth.uid()` (NULL), `auth.role()` (`'authenticated'`),
   `auth.jwt()` (`'{}'`); Tabellen `storage.buckets`/`storage.objects`. Damit laufen die
   unveränderten Upstream-Migrationen inklusive RLS-Policies durch.
2. `2025…`/`2026…` — die Upstream-Migrationen von ycode, byte-identisch. Dazwischen liegt die
   Webwow-eigene `20260324000001_create_webflow_imports_table.ts` (Webflow-ZIP-Importer).
3. `99999999999999_webwow_defaults.ts` — Whitelabel-Defaults (`ycode_badge=false`, `site_name`/
   `site_description`, falls noch Upstream-Default), idempotent, läuft immer zuletzt.

Die knex-CLI führt TypeScript-Migrationen über ts-node aus (`tsconfig.json` → `ts-node.transpileOnly`
+ `tsconfig-paths/register`, weil einige Upstream-Migrationen `@/lib/*` importieren). Im Docker-Image
liegen deshalb `lib/`, `types/`, `tsconfig.json`, `knexfile.ts` und die devDependencies.

## Wo ändere ich was?

| Ich will … | Datei(en) |
|---|---|
| DB-Verbindung, Pool, SSL | `knexfile.ts` (`DATABASE_URL`, `DATABASE_SSL`, `DB_POOL_*`) |
| Login, Cookie, Passwort-Hashing, Env-Bootstrap des Owners | `lib/webwow/auth-server.ts`, `app/(builder)/ycode/api/webwow/auth/*`, `lib/supabase-auth.ts`, `lib/supabase-route-client.ts`; Cookie-Prüfung im Edge-Kontext: `proxy.ts` (`verifyApiAuth`) |
| Browser-seitige Auth-Aufrufe / Realtime-No-op | `lib/supabase-browser.ts` |
| Ein neuer Supabase-Query-Builder-Aufruf aus Upstream funktioniert nicht | `lib/webwow/postgrest.ts` (Filter, Modifier, eingebettete Selects, jsonb) |
| Neue `rpc()`-Funktion aus Upstream | `lib/webwow/postgrest.ts` (`rpc`-Zweig; SQL aus der Upstream-Migration nachbauen) |
| Datei-Storage (Ablage, Public-URL, signierte Uploads) | Storage-Modul in `lib/webwow/`, `app/storage/v1/object/public/[bucket]/[...path]/route.ts`, `app/(builder)/ycode/api/webwow/storage/*`, `lib/webwow/fetch-intercept.ts` |
| "Ist Supabase konfiguriert?"-Logik, Setup-Wizard überspringen | `lib/credentials.ts` |
| Schema-Voraussetzungen für neue Upstream-Migrationen (`auth.*`, `storage.*`) | `database/migrations/00000000000000_webwow_bootstrap.ts` |
| Whitelabel-Defaults (Badge, Site-Name) | `database/migrations/99999999999999_webwow_defaults.ts` |
| Brand-Assets (Favicon, OG-Image, Manifest) | `public/favicon*.{svg,png}`, `public/apple-touch-icon.png`, `public/og-image.*`, `public/site.webmanifest`, `app/icon.svg` |
| Webflow-ZIP-Importer | `lib/services/webflowImportService.ts`, `lib/repositories/webflowImportRepository.ts`, `components/project/WebflowImportDialog.tsx`, Button in `app/(builder)/ycode/settings/templates/page.tsx`, Migration `20260324000001_create_webflow_imports_table.ts` |
| Öffentliche API-Routen ohne Login | `proxy.ts` → `PUBLIC_API_PREFIXES` / `PUBLIC_API_EXACT` |
| Redirect `/webwow` → `/ycode`, Upload-Body-Limit, standalone-Output, Turbopack-Root | `next.config.ts` (Stellen mit `// Webwow:`) |
| Docker-Image, Compose-Defaults, Start-Reihenfolge (Migrationen → `next start`) | `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, `.dockerignore` |
| Env-Variablen dokumentieren | `.env.example`, `README.md` (Tabelle), `docker-compose.yml` (Kommentare) |
| npm-Skripte (`migrate:*`, `sync:upstream`, `docker:*`) | `package.json` → `scripts` (Dependencies nur zusammen mit Upstream ändern) |
| Upstream-Update einspielen | `scripts/sync-upstream.sh`, [UPSTREAM-SYNC.md](UPSTREAM-SYNC.md) |
| Builder-Feature / CMS-Bug | **Upstream-PR bei ycode** — nicht im Fork patchen (sonst Merge-Konflikte) |

## Nicht-Ziele / bewusste Grenzen

* Kein Multi-Tenant, kein Supabase-RLS-Schutz (Webwow verbindet als DB-Owner; Zugriffskontrolle
  passiert in `proxy.ts` und den Upstream-Route-Handlern).
* Kein Realtime (Presence/Live-Cursor) — der Channel ist ein No-op; Single-Server-Modus.
* Keine E-Mail-Einladungen, kein Passwort-Reset per Mail.
* Kein Vercel: ISR-Cache-Tags, `vercel.json`-Crons und Function-Limits gelten nicht. Cron-Routen
  (`/api/cron/airtable-webhooks`) bei Bedarf extern mit `CRON_SECRET` aufrufen.
