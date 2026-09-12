# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
