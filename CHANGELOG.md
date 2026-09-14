# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.30.15-webwow.2] - 2026-09-14 — Mehrere Websites, `?edit`-Editor, Webflow-Importer v2

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

### Webflow-Importer v2 — jetzt der Importer — [docs/IMPORTER.md](docs/IMPORTER.md)

Der Dialog unter Einstellungen → Templates ruft ab sofort **v2** auf
(`POST /ycode/api/webwow/webflow/import`). v1 (`lib/services/webflowImportService.ts`,
`POST /ycode/api/webflow/import`) bleibt lauffähig, ist aber Legacy und wird von keiner Oberfläche
mehr benutzt.

- **Das Design wird übersetzt statt danebengelegt.** v1 hat das Webflow-Stylesheet wörtlich in
  `settings.custom_code_head` mitgeliefert (92,6 KB) und 658 Layer-Styles **ohne** Design-Daten
  angelegt — das Design-Panel war für jeden importierten Layer leer. v2 legt am Beispiel-Export 119
  Layer-Styles an, **116 davon (97,5 %) mit echten `design`-Daten**; 283 von 338 Layern tragen Design
  (87,1 % ohne Komponenten-Instanzen), und in `layer.classes` steht **kein** roher Webflow-Klassenname
  mehr. Im `custom_code_head` bleiben **5,2 KB** eingegrenztes Rest-CSS ohne `<script>`.
- **Webflow-Klassen werden wiederverwendbare Layer-Styles**, Combo-Klassen ein zweiter Style-Chip
  darüber, Tag-Regeln ein Underlay, `991px`/`767px` die ycode-Breakpoints `medium`/`small`, Hover ein
  `hover:`-Variant. Aus Webflows `normalize.css`/`components.css` (45 KB) werden nur die Tag-Regeln
  übernommen, der Rest verworfen.
- **Wiederkehrende Bereiche werden Komponenten**: 4 Komponenten (Navbar, Footer, fixed-menu_item,
  Div) mit 13 Instanzen. Weicht eine Instanz ab (`navbar black`), bleibt sie inline und wird als
  `component_skipped` gemeldet, statt die Komponente für alle zu verbiegen.
- **CMS**: CSV-Exporte werden Collections mit Feldtypen, Referenzen und Multi-Referenzen; die
  Collection-Listen im HTML werden strukturell gebunden (Sortierung, Limit, „nur veröffentlichte"),
  die Vorlagen-Felder an Text-, Rich-Text-, Bild-, **Hintergrundbild**-, Link- und
  Multi-Asset-Bindungen. Detailseiten binden gegen den aktuellen Eintrag.
- **Verhalten statt Webflow-Skripte**: Menü- und Dropdown-Klicks werden als ycode-Interaktionen
  erzeugt, Webflows IX2-Definitionen ohne `eval` gelesen und auf Animationen abgebildet (9 Hover,
  4 Scroll-into-view, 3 Klick). `webflow.js` und jQuery werden nicht mitgeliefert.
- **Webflow-Widgets werden native ycode-Elemente** (`lib/webwow/import/webflow-zip/widgets-native.ts`):
  `.w-slider` → `slider` mit `slides`/`slide` und den nativen Navigations- und Paginierungs-Layern,
  Einstellungen aus Webflows `data-*` (`data-infinite` → `loop`, Dauer in Sekunden, Effekt, Autoplay,
  Touch); `.w-lightbox` → `lightbox` samt Galerie aus dem `w-json`-Payload, deren Bilder mitgeladen
  und als Assets hinterlegt werden; `.w-form` → `form` mit Formular-Einstellungen, `input` /
  `textarea` / `select` / `option` / Button **mit** `name`, `type`, `placeholder`, `required` … (ohne
  sie käme die Absendung leer an) und `.w-form-done`/`.w-form-fail` als Erfolgs- bzw. Fehlermeldung
  **innerhalb** des Formulars; `.w-tabs` → DOM bleibt, das Umschalten wird wie Navbar und Dropdown als
  Klick-Interaktion erzeugt; `.w-row`/`.w-col-N` → Flex-Row mit echten Spaltenbreiten inklusive der
  `medium`/`small`-Varianten. Jeder Builder ist einzeln abschaltbar (`options.widgets`), und was
  erkannt, aber nicht vollständig abgebildet werden kann, meldet `widget_partial`.
- **CMS-Inhalte wahlweise über die Webflow Data API** (`lib/webwow/import/webflow-zip/data-api.ts`,
  optional). Die CSVs sind reiner Text, der Import muss den Feldtyp aus den Werten erraten; mit einem
  API-Token kommen dieselben Collections typisiert — `Option` samt aller Auswahlmöglichkeiten,
  `MultiImage`, `MultiReference`, `Number`, `Switch`, `Date`/`DateTime`, `RichText` — und mit echten
  Asset-URLs. **Der Token wird nicht gespeichert**: nur für diesen einen Request, in keiner Tabelle,
  keinem Log und keiner Antwort (echot Webflow ihn in einem Fehler, wird er vorher durch `<redacted>`
  ersetzt). Nur lesend, nur vier `GET`-Endpunkte, jede Anfrage durch dieselbe SSRF-Sperre wie jeder
  Asset-Download. Die Site-ID liest der Import aus dem Export (`data-wf-site`). Ohne Token bleibt
  alles wie bisher; beides zusammen geht auch (API gewinnt pro Collection, nur-CSV- und nur-API-
  Collections werden beide importiert und gemeldet). Fehler brechen ab, **bevor** geschrieben wird:
  `webflow_api_unauthorized` (401), `_forbidden` (403, fehlender Scope), `_not_found` (404, Site),
  `_rate_limited` (429, nach mehreren Wartezyklen gemäß `Retry-After`).
- **Rich Text behält seine Auszeichnungen.** Upstreams `htmlToTipTapJSON` entfernt jedes Inline-Tag
  außer `<a>`, sodass `<strong>`, `<em>`, `<u>`, `<s>` und `<code>` als reiner Text ankamen;
  `richtext.ts` läuft über den echten Baum und erzeugt die kanonischen TipTap-Formen
  (`richTextLink`, `richTextImage`) samt Marks.
- **Bekannt, aber nicht vom Importer**: ein importierter Slider wird korrekt als ycode-Slider
  angelegt, schaltet aber nicht weiter — ein von Hand eingesetzter Slider aus der Elementbibliothek
  verhält sich identisch (`syncBullets` in `lib/slider-utils.ts` liest `swiper.el`, bevor es gesetzt
  ist). Und ein Hintergrundvideo zeigt in einem Browser ohne H.264 nur sein Standbild, weil ycode
  eine Datei pro Video speichert und der Import die mp4 behält (`embed_dropped`). Beides steht in
  `docs/IMPORTER.md` § 3a.
- **Jeder Verlust wird gemeldet.** Der Ergebnisdialog zeigt die Zählungen und die Warnungen **nach
  Ursache gruppiert** (CSS ohne Entsprechung, geratene CMS-Zuordnung, Dateien, HTML/Widgets,
  Animationen, Sonstiges) mit einem Satz, was die Gruppe bedeutet. Zwei Optionen im Dialog:
  CDN-Download der CMS-Bilder abschalten und Slug-Kollisionen mit Suffix lösen statt abbrechen.
- **Ein Slug-Konflikt bricht ab, bevor geschrieben wird** (`400 {"code":"slug_conflict"}`); die
  Startseite und die Fehlerseiten der Migration werden wiederverwendet statt dupliziert.
- Neue Module: `server-materializer.ts` (schreibt über die Repositories, nie über HTTP oder Zustand),
  `convert-bridge.ts`, `components.ts`, `pages.ts`, `index.ts` und die Route
  `app/(builder)/ycode/api/webwow/webflow/import/route.ts` (owner|admin, multipart, 300 s).

**Korrekturen dieser Runde**

- **CMS-Hintergrundbilder blieben leer.** Die vier Klassen, die `--bg-img` überhaupt erst anzeigen
  (`bg-cover bg-center bg-no-repeat bg-[image:var(--bg-img)]`), standen nur in `layer.classes` — einem
  abgeleiteten Wert, den ycode aus dem Style-Stack neu berechnet. Sie werden jetzt als Override am
  obersten Style-Chip verankert und überleben jedes Neu-Auffalten; auf der Werk-Seite sind das 85
  Karten, die vorher nichts angezeigt haben.
- **Die zweite Videoquelle verschwand still.** Webflow liefert mp4 und webm, ycode speichert eine
  Datei pro Video. Die mp4 wird behalten, die verworfene webm jetzt als `embed_dropped` gemeldet.

### Nachgezogen aus dem alten Fork (0.9.x) — White-Label und Fehlerkorrekturen

Beim Neuaufbau als Kompatibilitätsschicht wurden alle Upstream-Dateien wieder byte-identisch, wodurch
Anpassungen des alten Forks (ed9d522 → 09bd627) verloren gingen. Sie sind jetzt wieder da; die
betroffenen Upstream-Dateien stehen in `scripts/sync-lists.sh` und sind in
[docs/UPSTREAM-SYNC.md](docs/UPSTREAM-SYNC.md) §2a einzeln mit Re-Apply-Anleitung dokumentiert.

**Fehlerkorrekturen**

- **MCP-`publish` löscht gelöschte Entwürfe jetzt auch veröffentlicht.** Eine über MCP gelöschte Seite
  (ebenso Komponenten, Layer-Styles, Collections) blieb nach `publish` weiter online, weil das
  MCP-Tool die Hard-Delete-Aufräumung der HTTP-Publish-Route nicht mitmachte.
- **Eigene Fehlerseiten funktionieren vor dem ersten Publish.** `/ycode/api/error-page` fällt auf die
  Entwurfsfassung und das Entwurfs-CSS zurück, solange nichts veröffentlicht ist — vorher zeigte eine
  frisch angelegte oder frisch importierte Site keine eigene 401/404/500-Seite.
- **Kein „Loading builder data…"-Blitz mehr.** Der Vollbild-Loader des Builders erscheint nur noch beim
  ersten Kaltstart, nicht bei jedem späteren kurzen `!builderDataPreloaded`.
- **Migrations-Check verschluckt keine HTML-Antwort mehr.** Antwortet ein Proxy oder eine 500-Seite mit
  HTML statt JSON, zeigt der Builder jetzt die Meldung statt `Unexpected token '<'`.

**White-Label**

- **Builder-Tab und PWA**: Titel „Webwow - Visual Website Builder", Favicons, `site.webmanifest`,
  Open-Graph-Bild und `theme-color` sind verdrahtet (die Asset-Dateien lagen bisher unbenutzt in
  `public/`). Bewusst **nur** im Builder-Layout — veröffentlichte Kundenseiten erben weder Favicon
  noch OG-Bild von Webwow.
- **~35 sichtbare „Ycode"-Texte** in Einstellungen, Integrationen (MCP, Webhooks, API, Airtable,
  Webflow, Static Export), OAuth-Zustimmung, HTML-Import, Backup/Restore, Update-Hinweis und im
  KI-Composer heißen jetzt „Webwow". Pfade, DOM-Ids, `ycode://`-URIs, `X-Ycode-*`-Header und die
  Export-Endung `.ycode` bleiben unverändert (Upstream-Kompatibilität).
- **Platzhalterseiten**: „Welcome to Webwow" (Setup-Assistent, leere Entwurfs- und veröffentlichte
  Startseite), „Webwow Preview"; ohne veröffentlichte Inhalte steht im `<title>` nichts mehr von
  „Ycode" / „Built with Ycode".
- **MCP-Tool-Beschreibungen**: Der KI-Assistent stellt sich nicht mehr als „YCode" vor.
- **Layout-Bibliothek**: Die Demo-Texte der Blog-Karten- und FAQ-Layouts warben für Ycode und die
  Header-/Footer-Layouts setzten die `ycode`-Wortmarke ein — beides landete beim Einfügen direkt auf
  der Seite des Nutzers. Texte und `public/ycode/layouts/assets/ycode-logo-black.svg` (gleiches
  132×35-Seitenverhältnis) tragen jetzt die Fork-Marke, ebenso `public/y-filled.svg`.
- **Statischer Export nach GitHub** committet als „Webwow Static Export" statt „Ycode Static Export".
- **„Made in Ycode"-Badge**: Der Code-Default ist jetzt *aus* (`PageRenderer`, `not-found`,
  `error-page`) — bisher hätte ein fehlender oder `NULL`-Wert der Einstellung ihn wieder eingeblendet.
  Der HTML-Kommentar `<!-- Made in Ycode · ycode.com -->` in veröffentlichten Seiten bleibt vorerst
  (Upstream 1.30.x, mit Tests abgesichert; siehe docs/UPSTREAM-SYNC.md §2a).
- **Repo-Doku**: `CONTRIBUTING.md`, `SECURITY.md` und `.cursorrules` sagen jetzt, was hierher gehört
  und was upstream. `LICENSE` und `CODE_OF_CONDUCT.md` bleiben absichtlich die Upstream-Fassung.

**Sonstiges**

- `/dev/css-controls` ist zurück: Entwickler-Sandbox für die Design-Control-Panels ohne Builder und
  ohne Datenbank (in einem Production-Build 404).
- `.gitignore` ignoriert `node_modules` in jedem Verzeichnis, nicht nur im Wurzelverzeichnis —
  sonst landet `tools/vscode-tailwind-class-editor/node_modules/` im Commit.

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
