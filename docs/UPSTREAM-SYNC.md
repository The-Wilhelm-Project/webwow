# Upstream-Sync: ycode → Webwow

Diese Anleitung richtet sich an die Maintainer von Webwow. Sie beschreibt, wie ein neues
ycode-Release (https://github.com/ycode/ycode) in den Fork übernommen wird, welche Dateien
absichtlich von Upstream abweichen und worauf nach jedem Merge zu achten ist.

Helfer: `npm run sync:upstream` (= `scripts/sync-upstream.sh`), Architektur-Überblick:
[ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Strategie: Kompatibilitätsschicht statt Rewrite

Der alte Fork (0.9.x) hatte ~106 Upstream-Dateien (Repositories, Services, Routen) von Supabase auf
knex umgeschrieben und `app/ycode` nach `app/webwow` umbenannt. Folge: jedes Upstream-Update war ein
manueller Re-Port mit hunderten Konflikten (allein der Rename produzierte ~690 von 772 Konflikten).

Seit 1.30.15-webwow.1 gilt:

* **Alle Upstream-Dateien bleiben byte-identisch.** Webwow ersetzt nur die Module, über die der
  Upstream-Code mit Supabase spricht ("Nahtstellen"), durch eigene Implementierungen mit derselben
  API-Oberfläche. Der restliche Upstream-Code läuft unverändert auf PostgreSQL + lokaler Platte.
* **Der Builder-Pfad bleibt `/ycode`.** Alte `/webwow/...`-URLs werden in `next.config.ts`
  permanent umgeleitet.
* Webwow-eigener Code liegt ausschließlich unter Pfaden, die Upstream nicht kennt (siehe 2b).

| Upstream-Nahtstelle | Webwow-Implementierung |
|---|---|
| `lib/supabase-server.ts` | `getSupabaseAdmin()` liefert einen knex-basierten Client-Shim: PostgREST-ähnlicher Query-Builder (`lib/webwow/postgrest.ts`), Storage auf Disk, Auth auf eigener `auth.users`-Tabelle, Realtime als No-op. Gleiche Exporte wie Upstream (`getSupabaseAdmin`, `getSupabaseConfig`, `testSupabaseConnection`, `runWithTenantId`, `tenantStore`, `getTenantIdFromHeaders`, `executeSql`). |
| `lib/supabase-auth.ts` | `getAuthUser()` prüft den Webwow-Session-Cookie und lädt den Benutzer aus `auth.users`. Rückgabe `{ user, client }`. |
| `lib/supabase-route-client.ts` | `createRouteClient()` liefert den Route-Client-Shim (`auth.getSession/getUser/signInWithPassword/updateUser/signOut/...` auf Cookies + `auth.users`). |
| `lib/supabase-browser.ts` | Browser-Shim: `auth.*` ruft `/ycode/api/webwow/auth/*`; `channel()` liefert einen No-op-Realtime-Channel; `removeChannel()` No-op. Exporte `createBrowserClient`, `createClient`, `resetBrowserClient` bleiben. |
| `lib/credentials.ts` | Synthetisiert eine `SupabaseConfig` aus `DATABASE_URL`, damit alle "ist konfiguriert?"-Prüfungen von Upstream bestehen. `set()`/`del()` sind No-ops (Setup-Wizard wird übersprungen). |
| `knexfile.ts` | Verbindung direkt aus `DATABASE_URL` (Pool aus Env, SSL via `DATABASE_SSL`); `client: WebwowPgClient` (`lib/webwow/sites/pg-client.ts`) wählt pro Request den Pool der aktuellen Site — Multi-Site, siehe [MULTISITE.md](MULTISITE.md). Migrationsverzeichnis unverändert. |
| `proxy.ts` | Upstream-Struktur, aber `verifyApiAuth` prüft den signierten Webwow-Cookie (HMAC) statt Supabase; `/ycode/api/webwow/auth/` ist öffentlich. Multi-Site: löst die Site pro Request auf (`lib/webwow/sites/resolve.ts`) und reicht sie als signierten Header `x-webwow-site` weiter; Editor-Sessions laufen durch `lib/webwow/proxy-policy.ts`. Rest (Security-Header, Pagination-Rewrite, MCP-Bypass) identisch. |

## 2. Welche Dateien weichen von Upstream ab?

### 2a. Absichtlich divergente Upstream-Dateien (Konflikte IMMER von Hand lösen)

Bei einem Konflikt: Upstream-Änderung lesen, verstehen, und die Webwow-Anpassung darauf neu
aufsetzen. Nie blind "ours" nehmen — sonst gehen Upstream-Fixes verloren.

| Datei | Warum sie abweicht |
|---|---|
| `lib/supabase-server.ts` | Nahtstelle (siehe Tabelle oben) |
| `lib/supabase-auth.ts` | Nahtstelle |
| `lib/supabase-route-client.ts` | Nahtstelle |
| `lib/supabase-browser.ts` | Nahtstelle |
| `lib/credentials.ts` | Nahtstelle |
| `knexfile.ts` | `DATABASE_URL` statt Supabase-Connection-String; `client: WebwowPgClient` (Multi-Site) |
| `proxy.ts` | Cookie-Verifikation, öffentliche `/ycode/api/webwow/auth/`-Routen; Multi-Site: Site-Auflösung, signierter `x-webwow-site`-Header, Editor-Policy |
| `lib/updates/check-updates.ts`, `app/(builder)/ycode/api/updates/releases/route.ts` | eine Zeile: `UPSTREAM_REPO` zeigt auf das Webwow-Repo (`WEBWOW_UPDATE_REPO`), sonst würde der Builder ycode-Releases als Update anbieten |
| `next.config.ts` | `output: 'standalone'`, Body-Limit 100 MB, Redirect `/webwow/*` → `/ycode/*` (ausgenommen `/webwow`, `/webwow/edit`, `/webwow/sites/**` — die liefert `app/(webwow)`), `turbopack.root`, Alias `next/cache` → `lib/webwow/next-cache.ts` (nur Server-Graph, Turbopack-Bedingung `browser`/`default` und webpack `isServer`) — alle Stellen mit `// Webwow:` markiert |
| `package.json` | Name/Version/Repo/Keywords, `migrate:*` mit `dotenv --`, `sync:upstream`, `docker:*`, `webwow:user`, `webwow:sites`; `test` = Upstream-Liste plus Glob `'lib/webwow/**/*.test.ts'` (in Anführungszeichen, damit Node und nicht die Shell expandiert). **Dependencies unverändert** übernehmen (plus `jszip`, `node-html-parser`, `dotenv-cli`) |
| `tsconfig.json` | `baseUrl`, `exclude` (`tools`, `import`, `uploads`), ts-node `transpileOnly` + `tsconfig-paths/register` (knex-CLI) |
| `eslint.config.mjs` | zusätzliche `ignores` (`tools/`, `import/`, `uploads/`, `docs/`) |
| `.env.example` | Webwow-Variablen, keine `SUPABASE_*` |
| `.gitignore`, `.dockerignore` | `/uploads`, Docker-Kontext |
| `README.md`, `CHANGELOG.md` | Webwow-Doku; im CHANGELOG steht der Upstream-Changelog unterhalb des Webwow-Eintrags |
| `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh` | Webwow-Deployment |
| `app/(builder)/ycode/settings/templates/page.tsx` | zusätzlicher "Webflow ZIP importieren"-Button |
| `public/favicon.svg`, `public/favicon-32.png`, `public/apple-touch-icon.png`, `public/og-image.png`, `public/og-image.svg`, `public/site.webmanifest`, `app/icon.svg` | Brand-Assets (Whitelabel) |
| `.github/**` | eigene Issue-/PR-Templates, keine ycode-CODEOWNERS |
| `instrumentation-client.ts` (nur falls angelegt) | optionaler Site-Switcher im Builder (MULTISITE.md); beim Anlegen in `DIVERGENT_FILES` eintragen |

### 2b. Webwow-eigene Dateien (Upstream kennt sie nicht → keine Konflikte)

* `lib/webwow/**` — Kompatibilitätsschicht: Query-Builder, Storage, Auth-Server, Fetch-Interceptor;
  `lib/webwow/sites/**` (Multi-Site: Site-Kontext, Registry, Site-Auflösung, site-aware knex-Client),
  `lib/webwow/next-cache.ts` (site-bezogener `next/cache`-Wrapper), `lib/webwow/proxy-policy.ts`
  (Editor-Policy des Proxys), `lib/webwow/import/**` (Webflow-Importer v2)
* `app/(builder)/ycode/api/webwow/**` — Auth-/Storage-/Sites-/Editor-/Webflow-Routen des Shims
* `app/(builder)/ycode/api/webflow/**` — Routen des Webflow-ZIP-Importers v1
* `app/(webwow)/**` — Sites-Dashboard (`/webwow`) und Editor-Login (`/webwow/edit`)
* `app/storage/**` — Auslieferung `/storage/v1/object/public/<bucket>/<pfad>`
* `types/webwow.ts` — Typen des Webflow-Importers
* `database/migrations/00000000000000_webwow_bootstrap.ts` — Schemata `auth`/`storage`, Rollen, `auth.users`, Hilfsfunktionen
* `database/migrations/99999999999998_webwow_sites.ts` — Multi-Site-Registry `webwow_sites` (Tabelle und Default-Zeile
  entstehen nur in der `DATABASE_URL`-Datenbank; in Site-Datenbanken ist die Migration ein No-op)
* `database/migrations/99999999999999_webwow_defaults.ts` — Whitelabel-Defaults (idempotent)
* `database/migrations/20260324000001_create_webflow_imports_table.ts` — Tabelle des Webflow-ZIP-Importers
* `database/README.md` — Hinweise zur Migrationsreihenfolge (steht in `DIVERGENT_FILES`; Upstream hat die Datei nicht)
* `lib/services/webflowImportService.ts`, `lib/repositories/webflowImportRepository.ts`,
  `components/project/WebflowImportDialog.tsx` — Webflow-ZIP-Importer
* `scripts/webwow-*.ts` (`webwow-user`, `webwow-sites`), `scripts/sync-upstream.sh`, `scripts/sync-lists.sh`,
  `scripts/check-upstream-identity.sh`
* `docs/**`, `.github/**`, `import/**` (Beispiel-Export), `tools/**`

Alles andere im Repository muss nach einem Merge **identisch mit Upstream** sein. Die Listen aus 2a/2b stehen
genau einmal in `scripts/sync-lists.sh` (`DIVERGENT_FILES`, `DIVERGENT_PREFIXES`); `sync-upstream.sh` und die
Identitätsprüfung lesen sie von dort. Prüfen:

```bash
bash scripts/check-upstream-identity.sh                     # gegen den Git-Ref upstream/main
bash scripts/check-upstream-identity.sh upstream/v1.31.0    # gegen einen anderen Ref (Tag, Branch, Commit)
bash scripts/check-upstream-identity.sh /pfad/zum/ycode     # gegen einen lokalen Upstream-Checkout (ohne Remote)
# Exit 0: nur gelistete Dateien weichen ab. Exit 1: ungelistete Abweichungen werden ausgegeben —
# entweder die Datei mit Upstream abgleichen oder, wenn die Abweichung gewollt ist, in
# scripts/sync-lists.sh eintragen UND hier in 2a/2b dokumentieren.
```

## 3. Sync-Ablauf Schritt für Schritt

Voraussetzungen: sauberer Arbeitsbaum, Node 20+, lokale PostgreSQL für Tests.

1. **Branch anlegen**
   ```bash
   git checkout -b sync/ycode-<version> main
   ```
2. **Upstream holen und Stand ansehen**
   ```bash
   npm run sync:upstream
   # = git remote add upstream https://github.com/ycode/ycode (falls nötig) && git fetch upstream
   #   + Anzahl/Liste der Upstream-Commits seit Merge-Base, geänderte divergente Dateien,
   #   neue Migrationen, grobe Suche nach neuen Supabase-Aufrufen
   ```
   Upstream-Releasenotes lesen (GitHub Releases / `CHANGELOG.md` im Upstream).
3. **Mergen**
   ```bash
   npm run sync:upstream -- --merge --take-upstream
   # = git merge --no-commit --no-ff upstream/main
   #   + Konflikte in NICHT-divergenten Dateien automatisch mit Upstream lösen
   #     (git checkout --theirs + git add; in Upstream gelöschte Dateien werden entfernt)
   ```
   Ohne `--take-upstream` werden die Konflikte nur gruppiert angezeigt. Ein bestimmter Ref:
   `--ref upstream/v1.31.0` (Upstream-Tags werden mitgeholt).
4. **Erwartete Konfliktdateien** (nur, wenn Upstream sie angefasst hat): die Liste aus 2a.
   Typisch sind `package.json`/`package-lock.json`, `next.config.ts`, `.env.example`,
   `proxy.ts` und `lib/supabase-server.ts`.
   Vorgehen pro Datei:
   * Upstream-Version ansehen: `git show upstream/main:<datei>`
   * Webwow-Delta ansehen: `git diff upstream/main -- <datei>` (vor dem Merge) bzw. die
     `// Webwow:`-Kommentare in der Datei
   * Upstream-Stand übernehmen und das Webwow-Delta neu einbauen; `git add <datei>`
   * `package-lock.json`: Upstream-Version nehmen und danach `npm install` laufen lassen, damit
     `jszip`, `node-html-parser`, `dotenv-cli` wieder eingetragen werden (`git diff package-lock.json`
     sollte nur diese Pakete zeigen)
5. **Nicht gelistete Dateien mit Konflikt** → immer Upstream (`git checkout --theirs -- <datei> && git add <datei>`).
   Taucht so ein Konflikt auf, ist das ein Zeichen, dass jemand versehentlich Upstream-Code
   verändert hat — die Änderung gehört dann entweder nach `lib/webwow` oder nach Upstream (PR).
6. **Bauen und prüfen**
   ```bash
   npm ci
   npm run type-check
   npm run lint
   npm test
   bash scripts/check-upstream-identity.sh   # nur gelistete Dateien dürfen von Upstream abweichen
   npm run build            # darf OHNE DATABASE_URL durchlaufen (einmal ohne, einmal mit WEBWOW_MULTI_SITE=1)
   ```
7. **Migrationen auf einer Test-DB** — zweimal: auf einer leeren DB und auf einer Kopie einer
   Produktiv-DB (`pg_dump | psql`):
   ```bash
   DATABASE_URL=postgresql://webwow:webwow_password@127.0.0.1:5432/webwow_sync_test npm run migrate:status
   DATABASE_URL=... npm run migrate:latest
   ```
8. **Smoke-Test** (`npm run dev` oder `docker compose up --build`):
   Login (E-Mail + Passwort), Seite anlegen/bearbeiten, Asset hochladen (Bild sichtbar im
   Canvas und auf der veröffentlichten Seite), Publish, CMS-Collection mit Items, Template-Export/-Import,
   Webflow-ZIP-Import, `/webwow` → `/ycode`-Redirect, `GET /ycode/api/setup/status`.
9. **Abschluss**
   * `package.json` → `"version": "<ycode-version>-webwow.1"`
   * `CHANGELOG.md` → neuer Eintrag oben (Verhaltensänderungen für bestehende Installationen!)
   * `git commit` (Merge-Commit), PR gegen `main`, Docker-Image bauen

## 4. Nach jedem Upstream-Release prüfen

Diese Prüfungen laufen nicht automatisch — der Shim deckt genau die Supabase-Oberfläche ab, die der
Upstream-Code zum Zeitpunkt des letzten Syncs benutzte.

### 4a. Neue Supabase-API-Nutzung → `lib/webwow` erweitern

```bash
git diff <merge-base> upstream/main -- app lib | grep -E '^\+' | grep -E '\.(rpc|channel|storage\.from|auth\.admin\.\w+)\('
git diff <merge-base> upstream/main -- app lib | grep -E '^\+' | grep -E '\.(select|insert|upsert|update|delete|order|range|or|not|filter|contains|textSearch|overlaps)\('
```

Achten auf:
* neue **Query-Builder-Methoden** (z. B. `textSearch`, `overlaps`, `csv()`, `explain()`),
  neue Filter-Operatoren in `.or(...)`/`.filter(...)`, neue Modifier-Optionen
  (`referencedTable`, `foreignTable`)
* neue **eingebettete Selects** (`tabelle!inner(...)`, `tabelle!left(...)`) — der Shim braucht
  die FK-Beziehung (siehe Liste in `lib/webwow/postgrest.ts`)
* neue **`rpc()`-Funktionen** — im Shim nachbauen (SQL in einer Upstream-Migration nachlesen)
* neue **Storage-Aufrufe** (`createSignedUrl`, `move`, `copy`, `getPublicUrl` mit
  `transform`-Optionen, neue Buckets)
* neue **Auth-Admin-Aufrufe** (`generateLink`, `inviteUserByEmail`, MFA) — implementieren oder
  sauber mit Fehlermeldung ablehnen
* neue **Realtime-Nutzung** (Broadcast/Presence) — im Single-Server-Modus No-op; prüfen, ob die
  UI damit klarkommt (kein Hänger auf `subscribe`)
* neue Nutzung von `getSupabaseConfig()`/`credentials` (Setup-Wizard-Schritte) — `lib/credentials.ts`
  muss weiterhin "konfiguriert" melden

### 4b. Neue Migrationen → Bootstrap erweitern

```bash
git diff --name-only --diff-filter=A <merge-base> upstream/main -- database/migrations
grep -lE 'auth\.|storage\.|supabase_|pg_net|vault\.|extensions\.' database/migrations/<neu>.ts
```

Alles, was eine Upstream-Migration in den Schemata `auth`, `storage`, `extensions`, `vault` oder
über Supabase-Rollen (`anon`, `authenticated`, `service_role`) voraussetzt, muss vorher von
`00000000000000_webwow_bootstrap.ts` angelegt werden (Tabellen, Spalten, Funktionen, Rollen,
Extensions). RLS-Policies laufen durch, weil die Rollen existieren; sie greifen aber nicht, da Webwow
als DB-Owner verbindet.

### 4c. Neue env-Vars

```bash
git diff <merge-base> upstream/main -- .env.example
git diff <merge-base> upstream/main -- app lib proxy.ts | grep -oE 'process\.env\.[A-Z0-9_]+' | sort -u
```

Neue Variablen in `.env.example` (mit Upstream-Kommentar), bei Bedarf in `docker-compose.yml`
und der README-Tabelle dokumentieren. Vercel-spezifische Variablen (`VERCEL_*`) ignorieren.

### 4d. Sonstiges

* `package.json` engines / Next-Major-Bump → Node-Version im `Dockerfile` (`node:20-alpine`) prüfen
* neue Dateien, die zur Laufzeit über `process.cwd()` gelesen werden (`grep -rn "process.cwd()" lib app`)
  → ins Runner-Stage des `Dockerfile` kopieren
* neue Upstream-Routen unter `/ycode/api/...`, die vor dem Login erreichbar sein müssen →
  `PUBLIC_API_PREFIXES` in `proxy.ts` abgleichen (und 4e: Scope-Tabelle + Editor-Policy)
* `vercel.json` bleibt unverändert im Repo (harmlos, nur Referenz)

### 4e. Multi-Site-Schicht (Cache-Wrapper, site-aware DB-Client, Proxy-Policy)

Die Multi-Site-Schicht ([MULTISITE.md](MULTISITE.md)) hängt an Upstream-Verträgen, die ein Release still
ändern kann:

```bash
# neue Cache-Primitive außerhalb von unstable_cache/revalidateTag (nur diese beiden scoped der Wrapper)
git diff <merge-base> upstream/main -- app lib components | grep -E '^\+' | grep -E "'use cache'|cacheTag\(|cacheLife\(|next: \{ tags|updateTag\(|revalidatePath\("
# neue Request-APIs in veröffentlichten Seiten (machen sie auch im Single-Site-Modus dynamisch)
git diff <merge-base> upstream/main -- 'app/(published)' components/PageRenderer.tsx | grep -E '^\+' | grep -E 'headers\(\)|cookies\(\)|connection\(\)|draftMode\(\)'
# neue Routen -> Editor-Policy und Scope-Tabelle
git diff --name-only --diff-filter=A <merge-base> upstream/main -- 'app/(builder)/ycode/api' 'app/(site)/api'
```

* `'use cache'`, `cacheTag()`, `cacheLife()`, `fetch(..., { next: { tags } })`: `lib/webwow/next-cache.ts`
  scoped nur `unstable_cache` (Key-Teil `site:<id>`, Tag-Präfix `s-<id>-`) und `revalidateTag`. Neue Primitive
  in Upstream brauchen eine eigene Site-Scoping-Entscheidung, sonst teilen sich Sites Cache-Einträge.
* `headers()`/`cookies()`/`connection()` in `app/(published)/**` oder `components/PageRenderer.tsx`: veröffentlichte
  Seiten wären dann auch ohne `WEBWOW_MULTI_SITE=1` dynamisch (die Garantie "im Single-Site-Modus wird
  `headers()` nie aufgerufen" gilt nur für den Wrapper selbst).
* Nach jedem **Next-Bump** `lib/webwow/sites/request-site.test.ts` und `lib/webwow/next-cache.test.ts` laufen lassen:
  sie zäunen die Internals `next/dist/server/app-render/work-unit-async-storage.external` (Store-Typen
  `request`/`unstable-cache`/`prerender-legacy`) und `next/dist/server/async-storage/request-store` ein. Der Alias
  in `next.config.ts` (`next/cache` → Wrapper, `next/cache.js` → Original, Client-Bundle unverändert) muss nach dem
  Bump mit `next build` und `next build --webpack` bestätigt werden.
* Nach jedem **knex-Bump** `lib/webwow/sites/pg-client.test.ts` laufen lassen (`knex/lib/dialects/postgres`;
  `acquireConnection`/`releaseConnection` sind die einzigen Pool-Berührungspunkte außerhalb von `client.js`;
  `withUserParams`-Klone teilen den Pool).
* Neue Routen unter `app/(builder)/ycode/api/**` oder `app/(site)/api/**` in `lib/webwow/proxy-policy.ts` einordnen
  (allow/deny/rewrite für Editor-Sessions) — `proxy-policy.test.ts` zählt alle `route.ts` auf und schlägt bei
  unklassifizierten Routen fehl. Besucher-Routen (ohne Login erreichbar: Formulare, Collection-Filter,
  `/ycode/api/v1/*`, MCP, OAuth) zusätzlich in die Scope-Tabelle `scopeFor()` in `lib/webwow/sites/resolve.ts`
  aufnehmen, sonst landen sie in der Default-Datenbank statt bei der Site des Hosts.
* Neue Tabellen mit Geheimnissen/Tokens (API-Keys, OAuth, Webhooks, SMTP): in `SCRUB_TABLES`
  (`lib/webwow/sites/service.ts`) ergänzen, sonst kopiert "Site duplizieren" sie mit.
* Neue Aufrufer von `getDb()`/`getKnexClient()`, die Benutzer- oder Registry-Daten lesen, müssen `getMainDb()`
  (`lib/webwow/sites/main-db.ts`) verwenden — der Standard-Client ist site-aware.

## 5. Checkliste: Was ist ein Breaking Change für Webwow?

Ein Upstream-Release ist für Webwow "breaking", wenn mindestens einer der Punkte zutrifft. Dann
vor dem Release einen Migrationshinweis in den CHANGELOG und ggf. Code in `lib/webwow` nachziehen.

- [ ] Upstream benutzt eine Supabase-Client-Methode, die der Shim nicht implementiert
      (`type-check` läuft trotzdem durch, weil die Typen aus `@supabase/supabase-js` kommen —
      der Fehler kommt erst zur Laufzeit!). Grep aus 4a durchgehen.
- [ ] Neue Migration referenziert `auth.*`, `storage.*` oder Supabase-Extensions, die der
      Bootstrap nicht anlegt (`migrate:latest` auf leerer DB schlägt fehl).
- [ ] Neue Migration ändert `auth.users`-Spalten oder erwartet Supabase-Trigger
      (z. B. `on_auth_user_created`).
- [ ] Upstream ändert das Storage-URL-Schema (`/storage/v1/object/public/...`) oder die
      Bucket-Namen → `app/storage/**`, Storage-Shim und der Fetch-Interceptor müssen folgen.
- [ ] Upstream ändert die Cookie-/Session-Logik in `proxy.ts` oder die Signatur von
      `getAuthUser()` / `createRouteClient()`.
- [ ] Upstream ändert die Exporte der Nahtstellen-Module (neue Funktion in `lib/supabase-server.ts`,
      die anderswo importiert wird) → Shim muss denselben Export anbieten.
- [ ] Upstream verschiebt/benennt den Builder-Pfad `/ycode` um oder ändert `app/(builder)`-Struktur
      → Redirect in `next.config.ts`, `PUBLIC_API_PREFIXES`, Healthcheck-URL anpassen.
- [ ] Upstream setzt neue Pflicht-env-Vars voraus oder liest `VERCEL_*`-Variablen für Kernlogik
      (z. B. URL-Bildung) → Fallback über `NEXT_PUBLIC_SITE_URL` prüfen.
- [ ] Next.js-Major-Update (Body-Size-Optionen, `proxy.ts`-Konventionen, Turbopack-Optionen
      in `next.config.ts`) oder Node-Mindestversion > 20.
- [ ] Upstream führt E-Mail-Versand für Kernfunktionen ein (Einladungen, Passwort-Reset) —
      Webwow hat keinen Mail-Transport für Auth.
- [ ] Upstream nutzt Realtime für etwas Funktionales (nicht nur Presence/Cursor), z. B.
      Job-Status-Updates → Polling-Fallback prüfen.
- [ ] Änderungen am Template-/Export-Format, die den Webflow-ZIP-Importer betreffen
      (`lib/import/**`, `lib/services/templateService*`).
- [ ] Upstream nutzt in veröffentlichten Seiten neue Cache-Primitive (`'use cache'`, `cacheTag`, `cacheLife`,
      `fetch`-Tags) oder neue Request-APIs (`headers()`, `cookies()`, `connection()`) → Multi-Site-Scoping bzw.
      statische Auslieferung prüfen (4e).
- [ ] Next ändert die Work-Unit-Store-Internals oder knex ändert `Client.acquireConnection/releaseConnection`
      → `request-site.test.ts`, `next-cache.test.ts`, `pg-client.test.ts` schlagen fehl; Site-Routing neu verifizieren.
- [ ] Neue Upstream-API-Route ohne Einordnung in `lib/webwow/proxy-policy.ts` → Enumerationstest rot;
      Besucher-Routen zusätzlich in `scopeFor()` (`lib/webwow/sites/resolve.ts`).
- [ ] Upstream greift direkt auf `knex.client.pool` zu oder baut eigene knex-Instanzen aus `knexfile` für
      Benutzer-/Registry-Daten → `WebwowPgClient` bzw. `getMainDb()` prüfen.

Nicht breaking (nur mergen und testen): neue Features/Routen, die ausschließlich über die
bereits abgedeckte Query-Builder-Oberfläche arbeiten; UI-Änderungen; neue Upstream-Migrationen
ohne Supabase-Schemabezug.
