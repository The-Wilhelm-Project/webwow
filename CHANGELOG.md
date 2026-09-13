# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.30.15-webwow.2] - 2026-09-13 — Mehrere Websites, `?edit`-Editor, Webflow-Importer v2

Alle Upstream-Dateien bleiben weiterhin byte-identisch (`bash scripts/check-upstream-identity.sh`).

### Mehrere Websites in einer Installation (optional, `WEBWOW_MULTI_SITE=1`) — [docs/MULTISITE.md](docs/MULTISITE.md)

- **Eine PostgreSQL-Datenbank pro Site** (`webwow_site_<slug>`, `CREATEDB` nötig) neben der bisherigen
  Installation, die zur Default-Site wird. Registry `webwow_sites` in der Haupt-Datenbank (Migration
  `99999999999998_webwow_sites`, seedet die Default-Zeile mit dem vorhandenen `site_name`; in
  Site-Datenbanken ein No-op). Benutzer und Rollen bleiben global.
- **Site-Auflösung im Proxy**: veröffentlichte Seiten und Besucher-Routen (Formulare, Collection-Filter,
  v1-API, MCP) nach Host (Domain → `<slug>.<WEBWOW_SITES_BASE_DOMAIN>` → `<slug>.localhost` → Default),
  Builder/API nach Editor-Pin → Cookie `webwow_site` → Default. Ergebnis ist der HMAC-signierte
  Request-Header `x-webwow-site`; eingehende `x-webwow-*` Header werden verworfen.
- **Site-aware Datenbank-Client** (`knexfile.ts` → `WebwowPgClient`): `getKnexClient()`, `getDb()`,
  PostgREST-Shim und Migrationen arbeiten automatisch auf der Datenbank der aktuellen Site (Pool pro Site,
  LRU-Deckel `WEBWOW_MAX_SITE_POOLS`, Budget-Formel in `.env.example`). Registry/`auth.users` immer über
  `getMainDb()`.
- **Storage**: `UPLOAD_DIR/sites/<id>/<bucket>/…` für weitere Sites, Default-Site unverändert; URLs
  `/storage/v1/object/public/<bucket>/sites/<id>/…`; Upload-Tokens tragen die Site.
- **Cache pro Site**: `next/cache` wird im Server-Bundle durch `lib/webwow/next-cache.ts` ersetzt
  (`unstable_cache`-Keys `site:<id>`, Tags `s-<id>-…`). Nur mit gesetztem Flag — ohne Flag bleiben
  Cache-Schlüssel und statische Seiten byte-identisch. Mit Flag werden veröffentlichte Seiten pro Anfrage
  gerendert; `clearAllCache()` leert das HTML aller Sites (dokumentiert).
- **Dashboard `/webwow`** (eigene Root-Layout-Gruppe `app/(webwow)`, dunkler Builder-Look, Karten wie
  Webflows "All sites"): New site (optional aus `.ycode`-Export), Open, View site, Duplicate (owner),
  Export (.ycode), Settings (Name, Slug, Domains, Editor-Passwort), Delete (mit getippter Bestätigung).
  Login-Formular wie im Builder; Editor-Sessions sehen einen Hinweis.
- **Sites-API** `/ycode/api/webwow/sites/**` (Rollen: auflisten/öffnen jede Session, ändern/löschen/
  importieren/exportieren owner|admin, duplizieren owner; Editor-Sessions 403). Duplizieren kopiert die
  Datenbank per `TEMPLATE` und leert danach Zugangsdaten, Tokens, Webhooks, Formulare, Versionen und die
  Registry in der Kopie; Kopie der Default-Site nur mit Bestätigung (kurze Unterbrechung).
- **CLI** `npm run webwow:sites -- list | migrate | create | delete | set-editor-password`;
  `docker-entrypoint.sh` migriert alle Site-Datenbanken nach `knex migrate:latest`.
- **Proxy-Härtung** (auch im Single-Site-Modus): `/ycode/api/auth/(users|invite|set-role)` verlangen eine
  Session (vorher öffentlich); `POST /ycode/api/setup/migrate` ohne Session läuft immer auf der
  Default-Site; `x-forwarded-host` nur mit `WEBWOW_TRUSTED_PROXY=1`.
- **Neue Variablen**: `WEBWOW_MULTI_SITE`, `WEBWOW_SITES_BASE_DOMAIN`, `WEBWOW_TRUSTED_PROXY`,
  `DB_POOL_MAIN_MAX`, `DB_POOL_SITE_MAX`, `WEBWOW_MAX_SITE_POOLS`; Dockerfile/Compose reichen
  `WEBWOW_MULTI_SITE` als Build-Arg und Env durch. `PAGE_AUTH_SECRET` ist im Multi-Site-Modus Pflicht.
- **Redirect** `/webwow/*` → `/ycode/*` gilt nur noch für alte Builder-Deep-Links; `/webwow`, `/webwow/edit`
  und `/webwow/sites/**` werden ausgeliefert.
- **Sync-Hygiene**: `scripts/sync-lists.sh` (eine Quelle für die Divergenz-Listen),
  `scripts/check-upstream-identity.sh` (schlägt bei ungelisteten Abweichungen fehl),
  `docs/UPSTREAM-SYNC.md` §4e (Cache-Primitive, `headers()` in veröffentlichten Seiten, Routen
  klassifizieren, Next-/knex-Bumps).

### `?edit`-Editor pro Site — [docs/EDITOR.md](docs/EDITOR.md)

- Pro Site ein Editor-Passwort (Dashboard → Settings oder CLI). `https://<domain>/?edit` führt zum
  Editor-Login (`/webwow/edit`); die Session ist per Token an die Site gebunden (12 h) und endet, sobald das
  Passwort geändert oder der Zugang deaktiviert wird.
- Editor-Sessions dürfen nur CMS-Inhalte, Assets, Übersetzungen und Textinhalte von Layern ändern
  (`lib/webwow/proxy-policy.ts`: allow/deny/rewrite pro Route, Enumerations-Test über alle `route.ts`);
  Design, Einstellungen, Benutzer, Integrationen und die Sites-API sind gesperrt.

### Webflow-Importer v2 — Vorarbeit, noch nicht aktiv — [docs/IMPORTER.md](docs/IMPORTER.md)

- Neue Pipeline unter `lib/webwow/import/webflow-zip/**`, die den Export in das native ycode-Modell
  überführen soll (CSS → Tailwind-Layer-Styles inkl. Breakpoints und Hover, HTML → Layer, CSV →
  Collections mit Referenzen, strukturelle CMS-Bindung, Webflow-Interaktionen → ycode-Animationen
  ohne `eval`, Menü-/Dropdown-Verhalten, Schriften, entschärftes Rest-CSS, Zip-Bomb- und
  SSRF-Grenzen). Mit Unit-Tests gegen den Beispiel-Export abgedeckt.
- **Noch nicht verdrahtet**: `server-materializer`, `convert-bridge`, `components`, `pages`, `index`
  und die API-Route fehlen. Der Code ist damit unerreichbar und ändert nichts am laufenden Betrieb;
  für Importe gilt weiterhin der bisherige Importer unter Einstellungen → Templates.

## [1.30.15-webwow.1] - 2026-09-12 — Upstream-Sync auf ycode 1.30.15

Erster Release der neuen Fork-Strategie. Die Versionsnummer folgt ab jetzt dem Upstream-Schema
`<ycode-Version>-webwow.<n>`. Die Einträge unterhalb dieses Abschnitts sind der unveränderte
Upstream-Changelog von ycode.

### Strategiewechsel: Kompatibilitätsschicht statt Rewrite

- Der alte Fork (0.9.x) hatte ~106 Upstream-Dateien (Repositories, Services, Routen) von Supabase auf
  knex umgeschrieben; jedes Upstream-Update war damit ein manuelles Re-Port.
- Jetzt bleiben **alle Upstream-Dateien byte-identisch**. Nur die Supabase-Nahtstellen
  (`lib/supabase-server.ts`, `lib/supabase-auth.ts`, `lib/supabase-route-client.ts`,
  `lib/supabase-browser.ts`, `lib/credentials.ts`, `knexfile.ts`, `proxy.ts`) werden durch eine
  Kompatibilitätsschicht unter `lib/webwow/**` ersetzt: PostgREST-ähnlicher Query-Builder auf knex,
  Storage auf der lokalen Platte, Auth auf einer eigenen `auth.users`-Tabelle, Realtime als No-op.
- Der Builder-Pfad bleibt intern `/ycode` (kein Verzeichnis-Rename mehr). Dadurch ist
  `git merge upstream/main` künftig nahezu konfliktfrei. Ablauf: `docs/UPSTREAM-SYNC.md`,
  Überblick: `docs/ARCHITECTURE.md`, Helfer: `npm run sync:upstream`.
- Damit kommen alle ycode-Features bis 1.30.15 mit (u. a. AI-Agent mit eigenem API-Key,
  Airtable-/Webflow-App-Integrationen, statischer Export, MCP-Server, globale Variablen,
  Versionen, Layouts).

### Verhaltensänderungen für bestehende Installationen

- **Builder-URL:** `/webwow/...` leitet permanent (308) auf `/ycode/...` um. Lesezeichen und
  Links aktualisieren; alte URLs funktionieren weiter.
- **Login:** statt nur Passwort jetzt **E-Mail + Passwort**. Das Owner-Konto wird beim ersten Start
  aus `ADMIN_EMAIL` (Default `admin@webwow.local`) und `ADMIN_PASSWORD` angelegt; das Env-Passwort
  wird für dieses Konto immer akzeptiert (Recovery). Weitere Benutzer mit Rollen
  (owner/admin/designer/editor) sind möglich, E-Mail-Einladungen (noch) nicht.
  Der Session-Cookie heißt jetzt `webwow_session` (vorher `webwow_admin_auth`) — nach dem Update
  einmal neu anmelden.
- **Uploads:** Ablage jetzt `UPLOAD_DIR/<bucket>/<pfad>` (Bucket `assets`); das alte Layout
  `UPLOAD_DIR/<pfad>` wird als Fallback weiterhin gelesen, ein Umkopieren ist nicht nötig.
  Öffentliche Asset-URLs lauten `/storage/v1/object/public/assets/<pfad>`.
- **Whitelabel:** die Einstellung `ycode_badge` wird jetzt respektiert (Default: aus, per Migration
  `99999999999999_webwow_defaults` gesetzt); ebenso `site_name`/`site_description`, sofern noch auf
  Upstream-Defaults.
- **Datenbank:** vorhandene Daten werden per Migration aufgerüstet — Reihenfolge
  `00000000000000_webwow_bootstrap` (legt Schemata `auth`/`storage`, Rollen und `auth.users` an) →
  alle Upstream-Migrationen bis 1.30.15 → `99999999999999_webwow_defaults`. Der Docker-Container
  führt `knex migrate:latest` bei jedem Start automatisch aus. **Vor dem Update ein `pg_dump`
  ziehen.**
- **Realtime/Presence:** im Single-Server-Modus deaktiviert (No-op-Channel); keine Live-Cursor.
- **Konfiguration:** neue Variablen `ADMIN_EMAIL`, `DATABASE_SSL`; `SUPABASE_*` werden ignoriert.
  `.env.example` ist die Referenz.
- **Docker:** Postgres-Port nur noch auf `127.0.0.1` gebunden; Healthcheck für den App-Container;
  `storage/` (Google-Fonts-Liste, Beispiel-Collections) und `next.config.ts` werden jetzt ins Image
  kopiert; `HUSKY=0` beim `npm ci`; Migrationen mit Retry beim Start.
- **Build/Tooling:** Next 16 (Turbopack), `output: 'standalone'`, Body-Limit 100 MB für den
  Webflow-ZIP-Import; `tools/`, `import/`, `uploads/`, `docs/` sind von tsc/eslint ausgenommen;
  `npm run migrate:*` lädt `.env` automatisch.

## [0.2.0] - 2026-03-03

### Added

- Filter layer with pagination integration for collections
- Dynamic sorting linked to filter form inputs
- Collection-sourced select options for reference field filtering
- Cascading component overrides with enhanced instance management
- Rich-text component overrides and editor UX improvements
- Semantic `<label>` tags for form input wrappers
- Components support in CMS rich-text editor
- Template or blank project choice in welcome flow

### Fixed

- Scope item reorder to draft rows for accurate publish detection
- Clean up soft-deleted entities during publish
- Sort items correctly after drag-and-drop reorder
- Prevent Space key from stealing focus in button text editor
- Resolve QueryBuilder crash in orphaned slug fixer
- Improve audio and video UX settings and component header clickable area in rich-text
- Preload assets in rich-text component overrides
- Improve UX for audio and link override settings in sheets
- Replace sort select with cancel button during linking
- Apply classes on body to prevent inner divs from interfering with styling
- Handle negative values in measurement class generation
- Prevent circular component rendering in LayerRenderer
- Resolve rich-text editor empty state in production and circular rendering via collections
- Harden filter pagination and option loading
- Improve linked filter behavior and picker UI
- Wrap multi-reference filter values in JSON array
- Use OR logic between filter form conditions

### Changed

- Standardize form template input defaults
- Replace sort-by field checkboxes with dropdown
- Update form classes and design data
- Improve line UI and placeholder design settings
- Update multi-reference filtering UI

## [0.1.0] - 2026-02-24

### Added

- Visual drag-and-drop website builder with real-time preview
- Page and folder management with nested routing
- Collections (CMS) with custom fields, items, and dynamic page binding
- CMS item draft/published status with revert-to-published support
- Collection and field deletion protection when in use
- Reusable components with variable support (icon, audio, video overrides)
- Layer styles for consistent design tokens
- Typography controls including body layer support
- Font picker with Google Fonts integration
- Background image support for layers
- Asset management with folder organization and SEO-friendly URLs
- Publishing system with draft/published states
- Password protection for pages and folders
- Localization and translation support
- Form submissions collection
- Template system for importing and exporting site designs
- Keyboard shortcuts for common actions
- Undo/redo support
- SEO settings per page (title, description, OG image)
- Custom code injection (head/body) per page
- Sitemap and robots.txt generation
- API key management for external integrations
- Webhook support for event-driven workflows
- Email integration via SMTP
- Version history tracking
- One-click updates via GitHub fork sync
- Self-hosted on Vercel with Supabase backend
- Row-level security (RLS) policies for improved data isolation
