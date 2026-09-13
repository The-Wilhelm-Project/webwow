# Mehrere Websites in einer Installation (Multi-Site)

Webwow kann mehrere voneinander getrennte Websites in **einer** Installation betreiben: eine
Datenbank und ein Upload-Verzeichnis pro Site, ein gemeinsamer Builder, ein Dashboard unter
`/webwow`. Der Upstream-Code (ycode) bleibt dabei byte-identisch — die Schicht liegt komplett in
`lib/webwow/sites/**`, `lib/webwow/next-cache.ts`, `lib/webwow/proxy-policy.ts`, `proxy.ts`,
`app/(webwow)/**` und `app/(builder)/ycode/api/webwow/sites/**`.

Verwandte Dokumente: [ARCHITECTURE.md](ARCHITECTURE.md) (Kompatibilitätsschicht),
[UPSTREAM-SYNC.md](UPSTREAM-SYNC.md) §4e (was bei Upstream-Updates zu prüfen ist),
[IMPORTER.md](IMPORTER.md) (Webflow-Import in eine Site), [EDITOR.md](EDITOR.md) (`?edit`-Editor).

## 1. Modell

| Begriff | Bedeutung |
|---|---|
| **Default-Site** | Die Installation selbst: Datenbank aus `DATABASE_URL`, Uploads unter `UPLOAD_DIR/<bucket>/…`. Registry-Zeile `id = 'default'`. Bestehende Installationen sind automatisch diese Site — nichts ändert sich. |
| **Site** | Eine weitere Website: eigene PostgreSQL-Datenbank `webwow_site_<slug>` auf demselben Server, eigene Uploads unter `UPLOAD_DIR/sites/<id>/<bucket>/…`, eigene Einstellungen, Seiten, CMS, Assets, Publish-Stand. Id `s_` + 10 Zeichen `[a-z0-9]`. |
| **Registry** | Tabelle `webwow_sites` **nur in der Haupt-Datenbank** (Migration `database/migrations/99999999999998_webwow_sites.ts`; in Site-Datenbanken ist sie ein No-op). Spalten: `id`, `slug`, `name`, `database_name` (null = Default), `domains` (jsonb), `is_default`, `editor_password_hash`, `editor_password_version`, `thumbnail_url`, Zeitstempel. |
| **Benutzer** | Global, in `auth.users` der Haupt-Datenbank. Rollen (owner/admin/designer/editor) gelten für alle Sites. Die Site-Datenbanken enthalten keine Benutzer. |
| **Site-Kontext** | Jede Anfrage läuft für genau eine Site. Innerhalb dieses Kontexts arbeiten `getDb()`, `getKnexClient()`, `getSupabaseAdmin()`, der Storage-Shim und `unstable_cache` automatisch auf den Daten dieser Site. |

## 2. Aktivieren

1. **Flag setzen:** `WEBWOW_MULTI_SITE=1` — beim **Build und zur Laufzeit** (Docker: `--build-arg
   WEBWOW_MULTI_SITE=1` bzw. `args.WEBWOW_MULTI_SITE` in `docker-compose.yml` **und** die gleichnamige
   Umgebungsvariable). Ohne das Flag läuft die Installation im Single-Site-Modus (§9).
2. **`PAGE_AUTH_SECRET` setzen** (`openssl rand -hex 32`). Es signiert den Site-Header des Proxys und
   jede Session; ohne konfiguriertes Secret verweigern Dashboard und CLI das Anlegen einer zweiten Site
   (`secret_required`).
3. **Datenbank-Rolle mit `CREATEDB`** (`ALTER ROLE webwow CREATEDB;`), damit Sites ihre Datenbank
   selbst anlegen können. Alternative ohne `CREATEDB`: Datenbank von Hand anlegen und die Site mit der
   CLI registrieren (§7).
4. **Migrieren:** `npm run migrate:latest` (Docker: automatisch beim Start). Die Migration
   `99999999999998` legt `webwow_sites` an und trägt die bestehende Installation als Default-Site ein
   (Name = `settings.site_name`).
5. **Dashboard öffnen:** `http://<host>:3002/webwow` — Anmeldung mit einem regulären Konto.

Docker-Start (`docker-entrypoint.sh`) führt nach `knex migrate:latest` zusätzlich
`scripts/webwow-sites.ts migrate` aus: alle registrierten Site-Datenbanken bekommen die ausstehenden
Upstream-Migrationen (nicht fatal, falls es fehlschlägt).

## 3. Request-Ablauf

```
Browser ──► proxy.ts
             1. Session-Cookie prüfen (webwow_session; kind=editor => an eine Site gepinnt)
             2. Site auflösen (lib/webwow/sites/resolve.ts)
                  public-Pfade  (veröffentlichte Seiten, /storage, /a, Formulare, v1-API, MCP …): Host → Domain → <slug>.<base> → Default
                  builder-Pfade (/ycode/**, /api/templates, /webwow/**):                          Editor-Pin → Cookie webwow_site → Default
             3. eingehende x-webwow-* Header verwerfen, signierten Header setzen:  x-webwow-site: <id>.<hmac-sha256>
             4. Editor-Policy (lib/webwow/proxy-policy.ts), Auth wie bisher
                     │
                     ▼
          Route Handler / Server Components (Upstream, unverändert)
                     │  getCurrentSiteId()  = AsyncLocalStorage (runInSite) → verifizierter Header → 'default'
                     ▼
          knexfile.ts  client: WebwowPgClient (lib/webwow/sites/pg-client.ts)
                     │  acquireConnection(): Default → normaler Pool; sonst Pool der Site (Registry → database_name)
                     ▼
          PostgreSQL: DATABASE_URL-Datenbank  ·  webwow_site_<slug>  ·  webwow_site_<slug2> …
```

* **Scope-Tabelle** (`scopeFor()` in `resolve.ts`): `public` = alles außerhalb von `/ycode`, `/api/templates`,
  `/webwow`, `/_next` **plus** die besucher-seitigen Routen unter `/ycode` (`POST /ycode/api/form-submissions`,
  `POST /ycode/api/collections/*/items/(filter|load-more)`, `/ycode/api/v1/*`, `/ycode/mcp*`, `/ycode/api/oauth/*`,
  `/ycode/api/revalidate`). Sie folgen dem **Host**, damit ein Formular auf Site B in der Datenbank von Site B
  landet. Alles andere ist `builder` und folgt dem Cookie/Pin.
* **Signierter Header:** Der Proxy ist die einzige Quelle von `x-webwow-site`; Client-seitig gesetzte
  `x-webwow-*` Header werden vor dem Weiterleiten gelöscht, die MAC wird in `getCurrentSiteId()` geprüft —
  ein gefälschter oder unsignierter Header fällt auf `default` zurück.
* **Registry-Cache:** 10 s in-process (`lib/webwow/sites/registry.ts`, auf `globalThis`, damit Proxy- und
  App-Bundle denselben Stand sehen); jede Mutation ruft `invalidateRegistry()`.
* **Pools:** pro Site ein eigener knex-Pool (`min 0`, `max DB_POOL_SITE_MAX`), promise-memoisiert, LRU-Deckel
  `WEBWOW_MAX_SITE_POOLS`. Die Haupt-Datenbank hat zusätzlich einen kleinen Registry-/Benutzer-Pool
  (`getMainDb()`, `DB_POOL_MAIN_MAX`), der nie site-aware ist.

## 4. Host-Routing

| Anfrage-Host | Ergebnis |
|---|---|
| exakt in `domains` einer Site (klein geschrieben, Port ignoriert) | diese Site |
| `<slug>.<WEBWOW_SITES_BASE_DOMAIN>` | Site mit diesem Slug |
| `<slug>.localhost` (auch ohne Base-Domain, für die Entwicklung) | Site mit diesem Slug |
| alles andere | Default-Site |

* `domains` pflegt das Dashboard (Settings → Domains, eine pro Zeile). Gültig: `^[a-z0-9.-]+$`, eindeutig über
  alle Sites (`409 domain_taken`). DNS der Domain auf diesen Server zeigen lassen; TLS terminiert wie bisher der
  Reverse-Proxy.
* `WEBWOW_TRUSTED_PROXY=1` lässt den Proxy `x-forwarded-host` statt `Host` verwenden — **nur** hinter einem
  Reverse-Proxy setzen, der den Header überschreibt.
* Der Builder (`/ycode`) und das Dashboard laufen auf dem Haupt-Host; die Vorschau (`/ycode/preview/**`)
  folgt dem Cookie, nicht dem Host.
* `previewUrl` im Dashboard: erste Domain → `<slug>.<base>` → `http://<slug>.localhost:<PORT>`.

## 5. Storage-Layout

| Site | Ablage | Öffentliche URL |
|---|---|---|
| Default | `UPLOAD_DIR/<bucket>/<pfad>` | `/storage/v1/object/public/<bucket>/<pfad>` |
| andere | `UPLOAD_DIR/sites/<id>/<bucket>/<pfad>` | `/storage/v1/object/public/<bucket>/sites/<id>/<pfad>` |

Die Datenbank speichert **logische** Pfade (`storage_path` ohne `sites/<id>/`); `lib/webwow/storage.ts` bildet
sie beim Lesen/Schreiben aus dem Site-Kontext auf den physischen Ort ab. Nur die URLs (`public_url` u. a.)
enthalten den physischen `sites/<id>/`-Teil — deshalb bleibt die Auslieferungsroute `/storage/**` kontextfrei.
Bucket-Operationen der Default-Site (`emptyBucket`, `deleteBucket`, Orphan-Cleanup) berühren `UPLOAD_DIR/sites/**`
nie. Signierte Upload-Tokens enthalten die Site (`s`); ein Token für Site A kann nicht unter Site B schreiben.

## 6. Dashboard `/webwow` und API

Anmeldung mit einem regulären Konto (Editor-Sessions aus `?edit` sehen nur einen Hinweis). Karten wie in
Webflows "All sites": Vorschaubild/Initialen, Name, Host, "Updated …", Badges `Default` und `Editor access`.
Kartenmenü: **Open** (Builder an diese Site pinnen), **View site**, **Duplicate** (nur owner), **Export
(.ycode)**, **Settings**, **Delete** (nicht für Default). "New site" legt eine Site an und kann optional einen
`.ycode`-Export (Settings → Templates → Export oder Kartenmenü) hineinladen.

API `/ycode/api/webwow/sites/**` (Session per Proxy, Rolle in `_shared.ts`; Editor-Sessions immer `403
editor_session`; ohne Registry `400 registry_missing`):

| Route | Rolle | Body / Antwort |
|---|---|---|
| `GET /sites` | jede reguläre Session | `{ data: { sites, currentSiteId, multiSite } }` |
| `POST /sites` | owner, admin | `{ name, slug? }` → `201 { data: site }`; `400` Validierung, `409 slug_taken` / `database_exists`, `500 createdb_denied` / `migration_failed` |
| `GET /sites/current` | jede | die Site dieser Anfrage (Cookie/Pin) |
| `GET /sites/[id]` | jede | Site |
| `PATCH /sites/[id]` | owner, admin | `{ name?, slug?, domains? }` — der Datenbankname bleibt beim Slug-Wechsel |
| `DELETE /sites/[id]` | owner, admin | Default → `400 default_site` |
| `POST /sites/[id]/open` | jede | setzt Cookie `webwow_site` (httpOnly, 30 Tage), `last_opened_at`; `{ data: { redirect: '/ycode' } }` |
| `POST /sites/[id]/duplicate` | owner | `{ name, slug?, confirmMainCopy? }` → `201`; Default-Quelle ohne Bestätigung `400 confirm_main_copy`, Quelle belegt `503 source_in_use` |
| `PUT /sites/[id]/editor-password` | owner, admin | `{ password: string \| null }` (min. 10 Zeichen; `null` deaktiviert) — beide Wege beenden alle Editor-Sessions der Site |
| `POST /sites/[id]/import` | owner, admin | multipart `file` (.ycode) + `password?` → `{ data: { stats } }` |
| `POST /sites/[id]/export` | owner, admin | `{ password? }` → Download `.ycode` |

Site-JSON: Registry-Zeile ohne `editor_password_hash`, plus `editorPasswordSet`, `previewUrl`, `publishedUrl`
(`/` für die Default-Site). Fehler haben die Form `{ error, code, errorTitle? }`.

## 7. CLI `npm run webwow:sites`

```bash
npm run webwow:sites -- list
npm run webwow:sites -- migrate                                  # alle Site-Datenbanken (macht docker-entrypoint.sh)
npm run webwow:sites -- create "Valeska" valeska
npm run webwow:sites -- set-editor-password valeska "geheimes-passwort"   # `-` statt Passwort: deaktivieren
npm run webwow:sites -- delete valeska --yes
```

Liest `DATABASE_URL` und `PAGE_AUTH_SECRET` aus `.env`. `create` migriert die neue Datenbank mit
`knex.migrate.latest()` (die App nutzt dafür den Upstream-`migrationService`). Ohne `CREATEDB`: Datenbank
`webwow_site_<slug>` von Hand anlegen (`CREATE DATABASE webwow_site_x OWNER webwow;`) und dann `create`
aufrufen — bei bestehender Datenbank meldet `create` `database_exists`; in dem Fall die Zeile manuell in
`webwow_sites` eintragen und `migrate` laufen lassen.

## 8. Provisionierung, Duplizieren, Löschen, Import/Export

* **Anlegen** (`createSite`): Name/Slug validieren (`^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$`, reservierte
  Slugs `default www api mail localhost ycode webwow admin static storage a`) → `CREATE DATABASE` auf der
  Haupt-Verbindung → Registry-Zeile → Migrationen + Seeds im Site-Kontext → `settings.site_name`. Schlägt ein
  Schritt fehl, werden Pools, Datenbank und Zeile wieder entfernt. Vorbedingung: die Haupt-Datenbank wurde
  einmal per CLI migriert (cluster-weite Rollen `anon`/`authenticated`).
* **Duplizieren** (`duplicateSite`, nur owner): Pools der Quelle schließen → `CREATE DATABASE … TEMPLATE …`
  (bei `55006` einmal `pg_terminate_backend` + Retry) → Registry → **Scrub-Liste** in einer Transaktion
  (`auth.users`, `api_keys`, `app_settings`, `mcp_tokens`, `mcp_oauth_*`, `webhooks`, `webhook_deliveries`,
  `form_submissions`, `webflow_imports`, `versions`, `ai_chats`, `collection_imports`, `webwow_sites`; Settings
  mit Agent-Keys, `email_*`/`smtp_*`, `published_at`; `migrations_lock` freigeben) → Upload-Verzeichnis kopieren
  → Storage-URLs in allen text/json(b)-Spalten umschreiben. Die Default-Site als Quelle erfordert eine
  Bestätigung: das Schließen ihrer Verbindungen unterbricht alle Sites kurz.
* **Löschen** (`deleteSite`): Pools → synthetischer Editor-Benutzer → `DROP DATABASE … WITH (FORCE)` →
  `UPLOAD_DIR/sites/<id>` → Registry-Zeile. Die Default-Site kann nicht gelöscht werden.
* **Import** (`importProjectIntoSite`): Upstream-`unpackImport`/`importProject` im Site-Kontext (gleicher Pfad wie
  "Import project" im Builder), anschließend `site_name` setzen und Cache leeren. Erlaubt auch für die
  Default-Site (owner/admin).
* **Export** (`exportSite`): Upstream-`exportProject`/`packExportToStream` im Site-Kontext, Dateiname aus dem
  Slug.

Alle `CREATE/DROP DATABASE`-Statements laufen auf `getMainDb()` (nie in einer Transaktion, nie über den
site-aware Client); ein Mutex serialisiert Anlegen/Duplizieren/Löschen/Import.

## 9. Single-Site-Garantie und Cache

Ohne `WEBWOW_MULTI_SITE=1` verhält sich die Installation exakt wie vorher: `resolveSiteIdForCache()` liefert
`default`, ohne `headers()` zu berühren — Cache-Keys und Tags sind byte-identisch, veröffentlichte Seiten
bleiben vollständig statisch, `next build` braucht keine Datenbank.

Mit dem Flag ersetzt `next.config.ts` den Bare-Import `next/cache` **serverseitig** durch
`lib/webwow/next-cache.ts` (Turbopack: bedingter Alias `{ browser: 'next/cache.js', default: … }`; webpack: nur
`isServer`). Der Wrapper re-exportiert alles aus `next/cache.js` und überschreibt nur `unstable_cache`
(Key-Teil `site:<id>`, Tags `s-<id>-<tag>`, ein realer Cache pro Site) und `revalidateTag` (gleiches Präfix).
Veröffentlichte Seiten werden dadurch **pro Anfrage gerendert** (Host → Site); die Daten dahinter sind pro Site
gecacht.

Bekannte site-übergreifende Effekte (bewusst, dokumentiert):

* `clearAllCache()` ruft `revalidatePath('/', 'layout')` — leert das HTML **aller** Sites (Publish/Import einer
  Site rendert die anderen beim nächsten Aufruf neu).
* Der `<!-- Published -->`-Stempel ist prozessweit (eine `published_at`-Zeit für alle Sites).
* `warmRoutes` nach einem Projekt-Import wärmt nur den Host der auslösenden Anfrage.
* Neue Cache-Primitive in Upstream (`'use cache'`, `cacheTag`, `cacheLife`, `fetch(…, { next: { tags } })`) sind
  **nicht** site-scoped — siehe UPSTREAM-SYNC.md §4e.

## 10. Verbindungsbudget

```
2 × DB_POOL_MAX + DB_POOL_MAIN_MAX + WEBWOW_MAX_SITE_POOLS × DB_POOL_SITE_MAX  <  max_connections
```

Defaults: `DB_POOL_MAIN_MAX=5`, `DB_POOL_SITE_MAX=5`, `WEBWOW_MAX_SITE_POOLS=20`, Idle-Timeout 30 s.
Empfehlung im Multi-Site-Betrieb: `DB_POOL_MAX=10` (dann 20 + 5 + 100 < 128 bei
`max_connections = 128`) oder `WEBWOW_MAX_SITE_POOLS` senken. Site-Pools jenseits des Deckels werden nach LRU
geschlossen, sobald sie keine Verbindung mehr benutzen.

## 11. Sicherheit

* **Header-Signatur:** `x-webwow-site: <id>.<hmac-sha256-hex>` mit `PAGE_AUTH_SECRET`; der Proxy löscht jeden
  eingehenden `x-webwow-*` Header. Ein Client kann die Site seiner Anfrage nicht wählen — nur über Host,
  Cookie (`webwow_site`, nur Builder-Pfade) oder Editor-Pin.
* **Editor-Pin:** `?edit`-Sessions (`kind: 'editor'`, `site`, `pv`) sind an ihre Site gebunden; das Cookie wird
  ignoriert. Unbekannte Site, deaktivierter Editor-Zugang oder geändertes Passwort (`pv` ≠
  `editor_password_version`) → `401 editor_session_invalid` (API) bzw. `302 /` — im Proxy **und** in
  `getCurrentUserFromCookies()`. Details: EDITOR.md.
* **Rollen:** Sites anlegen/ändern/löschen/importieren/exportieren = owner|admin; duplizieren = owner; öffnen und
  auflisten = jede reguläre Session; Editor-Sessions nie.
* **Scrub-Liste beim Duplizieren:** Zugangsdaten, Tokens, Webhooks, Formular-Einsendungen, Versionen und die
  Registry werden in der Kopie geleert (§8).
* **Geschlossene Lücken des Proxys:** `/ycode/api/auth/(users|invite|set-role)` verlangen eine Session;
  `POST /ycode/api/setup/migrate` ohne Session ist an die Default-Site gepinnt; `x-forwarded-host` nur mit
  `WEBWOW_TRUSTED_PROXY=1`.
* Benutzer sind global: wer sich anmelden kann, sieht alle Sites im Dashboard (Rollen gelten überall).

## 12. Site-Switcher im Builder (optional)

Der Builder (`app/(builder)/ycode/layout.tsx`, Upstream-Datei) wird nicht angefasst. Welche Site gerade
geöffnet ist, zeigt eine kleine Pille unten links, die `instrumentation-client.ts` (Webwow-eigen, im Repo-Root)
per DOM einhängt, sobald `GET /ycode/api/webwow/sites/current` mehr als eine Site meldet. Fehlt die Datei,
bleibt `/webwow` per URL erreichbar und "Open" im Dashboard führt in den Builder.

## 13. Fehlerbilder

| Meldung | Ursache / Abhilfe |
|---|---|
| `registry_missing` / "Multi-site registry missing" im Dashboard | `npm run migrate:latest` (bzw. Container neu starten) — Migration `99999999999998` fehlt |
| `secret_required` | `PAGE_AUTH_SECRET` setzen und neu starten |
| `createdb_denied` | `ALTER ROLE <user> CREATEDB;` oder Datenbank manuell anlegen (§7) |
| `database_exists` | Datenbank `webwow_site_<slug>` existiert bereits — anderen Slug wählen oder Registry-Zeile manuell ergänzen |
| `migration_failed … role "anon" does not exist` | Haupt-Datenbank einmal per CLI migrieren (`npm run migrate:latest`), dann Site erneut anlegen |
| `source_in_use` beim Duplizieren | Quelle hat noch offene Verbindungen (anderer Prozess/psql) — kurz warten, erneut versuchen |
| Host zeigt die falsche Site | `domains` prüfen (klein, ohne Port), hinter Reverse-Proxy `WEBWOW_TRUSTED_PROXY=1`; Registry-Cache bis 10 s |
| Veröffentlichte Seiten sind nach Aktivierung "dynamisch" | erwartet (§9) — Daten sind weiterhin gecacht |

## 14. Tests und Sync

Unit-Tests: `lib/webwow/sites/*.test.ts`, `lib/webwow/next-cache.test.ts`, `lib/webwow/proxy-policy.test.ts`
(zählt alle `route.ts` auf), `lib/webwow/storage.test.ts`, `app/(builder)/ycode/api/webwow/sites/_shared.test.ts`
(`npm test -- "app/(builder)/ycode/api/webwow/sites/_shared.test.ts"`). Nach jedem Upstream-Release:
UPSTREAM-SYNC.md §4e (neue Routen klassifizieren, Cache-Primitive, `headers()` in veröffentlichten Seiten,
Next-/knex-Bumps).
