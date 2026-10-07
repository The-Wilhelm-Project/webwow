## Webwow

A no-code platform that combines a visual HTML editor with a dynamic CMS running on [ycode][ycode-repo]. 
It serves as an open-source and selfhost Webflow alternative featuring a seamless migration assistant.

**Quick Start:** ```docker pull html67/webwow:latest```

## Key Features
- [Docker](https://docs.docker.com/get-docker/), no need for Supabase and Vercel
- "State of the art" UX Theme
- Migration Assistant (beta)
- Universal ontology template: 12 Schema.org-aligned CMS collections with sample data, list/detail pages and SEO bindings (see [docs/universal-ontology.md](docs/universal-ontology.md))

### Migration Assistant (beta)
Bring existing sites into Webwow:

| Importer | Files needed |
| --- | --- |
| ycode | `export.ycode` file |
| Webflow | `export.zip` |
| Webflow CMS | `export.zip` + `collection_A.csv,collection_B.csv` + `www.url.xyz` |


## Configuration

The defaults in `docker-compose.yml` are meant for local use. **Before exposing Webwow to the internet, change at least these two values** in the `app` service:

| Variable | Purpose | Default |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Login password for the builder (empty = login disabled) | `changeme` |
| `PAGE_AUTH_SECRET` | Secret for signing auth cookies — generate with `openssl rand -hex 32` | placeholder |
| `DATABASE_URL` | PostgreSQL connection string | points to the bundled `db` service |
| `UPLOAD_DIR` | Directory for uploaded assets | `/app/uploads` (Docker volume) |

Uploads and the database are persisted in the named volumes `uploads` and `postgres_data`, so your data survives updates and container rebuilds.

## Manual Installation
### Option 1: Docker

Download this repository, then:

```bash
docker compose up -d
```
The builder is now available at [http://localhost:3002](http://localhost:3002).

Updating to a new version:

```bash
docker compose pull && docker compose up -d       # prebuilt image
docker compose up -d --build                      # built from source
```
### Option 2: Development Setup

If you want to work on the code directly, you need Node.js 20+ and a running PostgreSQL instance:

```bash
cp .env.example .env    # set DATABASE_URL, ADMIN_PASSWORD, PAGE_AUTH_SECRET
npm ci
npm run migrate:latest
npm run dev             # starts on http://localhost:3002
```

## Documentation & Support

Since Webwow runs on ycode,the [ycode documentation](https://docs.ycode.com/docs) is the best reference for the builder and CMS features. 
There is no official support for Webwow. But your AI coding assistant may do a great job, we left a lot of markdown context files to index the code. 

### Contributing

*Put your energy into yCode ;-)

We are working on:
- [Medusa.js](https://medusajs.com) native shop integration, Shopify importer
- Better component and animation Import, universal AI Importer
- Transition from Tailwind back to native CSS & [HTML67](https://html67.org)

## License

Webwow is open source software licensed under the [GNU AGPL v3](https://opensource.org).
Part of [Project Wilhelm](https://projectwilhelm.com),a developer collectiv on a mission to fully democratise digitisation by 2030
