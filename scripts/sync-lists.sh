#!/usr/bin/env bash
#
# Webwow: gemeinsame Listen für den Upstream-Sync.
#
# Wird von scripts/sync-upstream.sh und scripts/check-upstream-identity.sh per `source`
# geladen. Keine Seiteneffekte, kein `set -e` — nur Arrays und eine Hilfsfunktion.
# Dokumentation: docs/UPSTREAM-SYNC.md §2.
#
# Neue Webwow-eigene Datei oder neue absichtliche Abweichung von Upstream?
#   -> hier eintragen UND in docs/UPSTREAM-SYNC.md §2a/§2b dokumentieren.
#   `scripts/check-upstream-identity.sh` schlägt sonst fehl, und `sync-upstream.sh --take-upstream`
#   würde die Datei bei einem Konflikt mit der Upstream-Version überschreiben.

# Dateien, die absichtlich von Upstream abweichen. Konflikte hier IMMER von Hand lösen:
# Upstream-Änderung lesen und die Webwow-Anpassung neu einbauen.
DIVERGENT_FILES=(
  "lib/supabase-server.ts"
  "lib/supabase-auth.ts"
  "lib/supabase-route-client.ts"
  "lib/supabase-browser.ts"
  "lib/credentials.ts"
  "knexfile.ts"
  "proxy.ts"
  "lib/updates/check-updates.ts"
  "app/(builder)/ycode/api/updates/releases/route.ts"
  "next.config.ts"
  "package.json"
  "package-lock.json"
  "tsconfig.json"
  "eslint.config.mjs"
  ".env.example"
  ".gitignore"
  ".dockerignore"
  "README.md"
  "CHANGELOG.md"
  "Dockerfile"
  "docker-compose.yml"
  "docker-entrypoint.sh"
  "database/README.md"
  "app/(builder)/ycode/settings/templates/page.tsx"
  "app/icon.svg"
  "public/favicon.svg"
  "public/favicon-32.png"
  "public/apple-touch-icon.png"
  "public/og-image.png"
  "public/og-image.svg"
  "public/site.webmanifest"
)

# Pfad-Präfixe, die nur in Webwow existieren (Upstream kennt sie nicht). Konflikte hier sind
# unwahrscheinlich; falls doch: von Hand.
DIVERGENT_PREFIXES=(
  "lib/webwow/"
  "app/(builder)/ycode/api/webwow/"
  "app/(builder)/ycode/api/webflow/"
  "app/(webwow)/"
  "app/storage/"
  "types/webwow"
  "database/migrations/00000000000000_"
  "database/migrations/99999999999998_"
  "database/migrations/99999999999999_"
  "database/migrations/20260324000001_create_webflow_imports_table"
  "lib/services/webflowImportService"
  "lib/repositories/webflowImportRepository"
  "components/project/WebflowImportDialog"
  "docs/"
  "scripts/sync-upstream.sh"
  "scripts/sync-lists.sh"
  "scripts/check-upstream-identity.sh"
  "scripts/webwow-"
  ".github/"
  "import/"
  "tools/"
)

# is_divergent <pfad> -> 0, wenn der Pfad in DIVERGENT_FILES steht oder mit einem DIVERGENT_PREFIXES-Eintrag beginnt.
is_divergent() {
  local f="$1" d
  for d in "${DIVERGENT_FILES[@]}"; do [ "$f" = "$d" ] && return 0; done
  for d in "${DIVERGENT_PREFIXES[@]}"; do case "$f" in "$d"*) return 0 ;; esac; done
  return 1
}
