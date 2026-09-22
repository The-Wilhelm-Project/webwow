## Webwow

A no-code platform that combines a visual HTML editor with a dynamic CMS, running on [ycode][ycode-repo] 1.30.x.
It is an open-source, self-hosted Webflow alternative with a migration assistant.

**Quick start:** `docker compose up -d` → open [http://localhost:3002/ycode](http://localhost:3002/ycode)

## What Webwow adds on top of ycode

- **Docker + plain PostgreSQL only** — no Supabase, no Vercel. Uploads are stored on local disk.
- **Local multi-user auth** — e-mail + password with roles (owner / admin / designer / editor), no external auth provider.
- **Webflow ZIP importer** (migration assistant) in addition to ycode's built-in Webflow app integration.
- **Multiple websites per installation** (optional) — one database per site, a sites dashboard at `/webwow`,
  `.ycode` import/export per site and a password-protected `?edit` content editor. See "Mehrere Websites" below.
- **Whitelabel defaults** — ycode badge off, own brand assets.
- Everything else is unmodified ycode. Upstream code runs on a small compatibility layer
  (`lib/webwow/**`, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)), which keeps upstream updates cheap.

### Migration assistant (beta)

Bring existing sites into Webwow via *Settings → Templates*:

| Importer | Files needed |
| --- | --- |
| ycode | `export.ycode` file |
| Webflow | `export.zip` |
| Webflow CMS | `export.zip` + `collection_A.csv,collection_B.csv` + `www.url.xyz` |

## Quick start (Docker)

```bash
git clone https://github.com/The-Wilhelm-Project/webwow.git
cd webwow
docker compose up -d
```

The builder is now available at [http://localhost:3002/ycode](http://localhost:3002/ycode)
(the old `/webwow` path redirects there). Log in with the owner account from `docker-compose.yml`
(`admin@webwow.local` / `changeme`). Database migrations run automatically every time the
container starts.

Updating to a new version:

```bash
git pull && docker compose up -d --build
```

## Configuration

The defaults in `docker-compose.yml` are meant for local use. **Before exposing Webwow to the internet,
change at least `ADMIN_PASSWORD` and `PAGE_AUTH_SECRET`** (and the database password).

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (required) | points to the bundled `db` service |
| `ADMIN_EMAIL` | E-mail of the owner account created on first start | `admin@webwow.local` |
| `ADMIN_PASSWORD` | Password of the owner account; always accepted for that account (recovery). Empty = create the first account in the welcome wizard | `changeme` |
| `PAGE_AUTH_SECRET` | Signs session and page-auth cookies — generate with `openssl rand -hex 32` | placeholder, **change it** |
| `UPLOAD_DIR` | Directory for uploaded assets | `/app/uploads` (Docker volume `uploads`) |
| `PORT` | HTTP port | `3002` |
| `DATABASE_SSL` | `true` for managed Postgres that requires TLS | empty |
| `WEBWOW_SECURE_COOKIES` | Force the session cookie `Secure` flag (`true`/`false`); default follows `x-forwarded-proto` / request protocol, so plain http on a LAN works | auto |
| `WEBWOW_UPDATE_REPO` | GitHub repo the in-app update check reads releases from | `The-Wilhelm-Project/webwow` |
| `WEBWOW_MULTI_SITE` | `1` enables multiple websites per installation (build **and** runtime; see [docs/MULTISITE.md](docs/MULTISITE.md)) | `0` |
| `WEBWOW_SITES_BASE_DOMAIN` | Optional host suffix for site previews: `<slug>.<base>` serves that site | empty (`<slug>.localhost` only) |
| `WEBWOW_TRUSTED_PROXY` | `1` to resolve sites from `x-forwarded-host` — only behind a reverse proxy that sets it | empty |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | Optional: enables the in-app AI agent (bring your own key) | empty |

All variables, including the optional ones (templates API, maps, cron secrets), are documented in
[`.env.example`](.env.example). Upstream `SUPABASE_*` variables are ignored.

Uploads and the database are persisted in the named volumes `uploads` and `postgres_data`, so your
data survives updates and container rebuilds. Back up with `pg_dump` plus a copy of the `uploads` volume.

## Mehrere Websites

Webwow kann optional **mehrere getrennte Websites in einer Installation** betreiben: jede Site bekommt eine eigene
PostgreSQL-Datenbank (`webwow_site_<slug>`) und ein eigenes Upload-Verzeichnis, der Builder ist gemeinsam,
Benutzer und Rollen gelten für alle Sites. Aktivieren mit `WEBWOW_MULTI_SITE=1` (beim Build **und** zur
Laufzeit), gesetztem `PAGE_AUTH_SECRET` und einer DB-Rolle mit `CREATEDB`; danach `npm run migrate:latest`
(Docker: automatisch) und das Dashboard unter `http://localhost:3002/webwow` öffnen.

- **Dashboard `/webwow`** — Karten wie in Webflows "All sites": Site öffnen, ansehen, duplizieren, als `.ycode`
  exportieren, Einstellungen (Name, Slug, Domains, Editor-Passwort), löschen. "New site" kann direkt einen
  `.ycode`-Export einspielen.
- **Domains** — eine Site wird über ihre Domains (DNS auf diesen Server) oder `<slug>.<WEBWOW_SITES_BASE_DOMAIN>`
  ausgeliefert; alles andere landet bei der Default-Site (der bisherigen Installation). Lokal funktioniert
  `<slug>.localhost:3002`.
- **`?edit`-Editor** — pro Site ein Passwort, mit dem Redakteure unter `https://<domain>/?edit` nur die
  CMS-Inhalte bearbeiten (kein Design, keine Einstellungen): [docs/EDITOR.md](docs/EDITOR.md).
- **Webflow-Import in eine Site** — Export-ZIP (+ CMS-CSVs) wählen, Site auswählen, importieren:
  [docs/IMPORTER.md](docs/IMPORTER.md).
- **CLI** — `npm run webwow:sites -- list | create <name> [slug] | migrate | delete <slug> --yes |
  set-editor-password <slug> <passwort|->`.

Ohne das Flag verhält sich Webwow exakt wie eine Einzel-Installation (statische veröffentlichte Seiten, gleiche
Cache-Schlüssel). Details, Request-Ablauf, Storage-Layout, Verbindungsbudget und bekannte Grenzen:
[docs/MULTISITE.md](docs/MULTISITE.md).

## Development setup

You need Node.js 20+ and a running PostgreSQL instance:

```bash
cp .env.example .env    # set DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, PAGE_AUTH_SECRET
npm ci
npm run migrate:latest  # loads .env, runs database/migrations with knex
npm run dev             # http://localhost:3002/ycode
```

Useful scripts: `npm run type-check`, `npm run lint`, `npm test`, `npm run migrate:status`,
`npm run webwow:sites -- list` (multi-site CLI), `npm run docker:build` / `npm run docker:up`,
`npm run sync:upstream` (see below).

## Updating from upstream ycode

Webwow keeps all upstream files byte-identical and only replaces the Supabase seam modules, so pulling a
new ycode release is a normal git merge:

```bash
npm run sync:upstream            # fetch upstream, show what is new
npm run sync:upstream -- --merge --take-upstream   # merge, auto-resolve non-Webwow conflicts
```

The full procedure, the list of intentionally divergent files and the post-merge checklist are in
[docs/UPSTREAM-SYNC.md](docs/UPSTREAM-SYNC.md) (German).

## Known limitations

- **Multi-site mode renders published pages per request** (host → site); data stays cached per site. Single-site installs keep fully static pages. Publishing one site clears the HTML cache of all sites (see [docs/MULTISITE.md](docs/MULTISITE.md)).
- **No e-mail invites.** Upstream's "invite team member by e-mail" flow returns an error; Webwow has no mail-based invite yet.
- **No realtime collaboration / presence.** The realtime channel is a no-op in single-server mode (no live cursors or multi-user presence).
- **Static export to S3** works but is optional (`@aws-sdk/client-s3` is an optional dependency).
- Vercel-specific behaviour (ISR cache tags, `vercel.json` crons and function limits) does not apply; `vercel.json` is kept only for reference.

## Documentation & Support

Since Webwow runs on ycode, the [ycode documentation](https://docs.ycode.com/docs) is the best reference for the
builder and CMS features. There is no official support for Webwow, but your AI coding assistant may do a great
job — the repository contains a lot of markdown context files to index the code.

### Contributing

*Put your energy into ycode ;-)* — builder and CMS improvements belong upstream. Webwow-specific work
(Postgres/Docker layer, Webflow ZIP importer, whitelabel) is welcome here.

We are working on:
- [Medusa.js](https://medusajs.com) native shop integration, Shopify importer
- Better component and animation import, universal AI importer
- Transition from Tailwind back to native CSS & [HTML67](https://html67.org)

## License

Webwow is open source software under the [MIT License](LICENSE), the same license as ycode
(the `LICENSE` file in this repository is the upstream ycode MIT license).
Part of [Project Wilhelm](https://projectwilhelm.com), a developer collective on a mission to fully
democratise digitisation by 2030.

[ycode-repo]: https://github.com/ycode/ycode
