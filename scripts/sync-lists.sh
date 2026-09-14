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
  # White-Label: Wilhelm-Marke statt ycode-Logo, kein "Made in Ycode"-Badge, generator-Meta "Webwow".
  # Bei einem Sync: Upstream-Änderung übernehmen und die Marke erneut einsetzen (Pfad aus app/icon.svg).
  "app/(builder)/ycode/components/HeaderBar.tsx"
  "app/(builder)/ycode/accept-invite/page.tsx"
  "components/site-document-layout.tsx"
  # White-Label, zweite Welle: sichtbare "Ycode"-Texte in App-Registry, MCP-Instruktionen,
  # Update-Hinweis, Test-Webhook, Static-Export-Autor, Badge-Beschriftung und Web-Clip-Vorschau.
  "lib/apps/registry.ts"
  "lib/mcp/instructions.ts"
  "lib/mcp/resources/reference.ts"
  "app/(builder)/ycode/api/webhooks/[id]/route.ts"
  "lib/apps/static-export/writers/github.ts"
  "lib/apps/static-export/types.ts"
  "app/(builder)/ycode/integrations/apps/static-export-settings.tsx"
  "components/YcodeBadge.tsx"
  "public/webwow-webclip.png"
  "lib/apps/static-export/document.ts"
  "lib/services/webflowImportService.ts"

  # White-Label: Marken-Metadaten des Builders (Titel, Icons, Manifest, Open Graph, themeColor).
  # Re-Apply: in RootLayoutShell nur den Titel ersetzen; Icons/Manifest/OG gehören ausschließlich
  # in app/(builder)/layout.tsx, sonst erben veröffentlichte Kundenseiten Webwows Favicon.
  "components/RootLayoutShell.tsx"
  "app/(builder)/layout.tsx"
  "public/y-filled.svg"
  "public/ycode/layouts/assets/ycode-logo-black.svg"

  # White-Label: sichtbare "Ycode"-Texte in der Builder-Oberfläche -> "Webwow".
  # Re-Apply: Upstream-Fassung übernehmen und nur die Textstellen ersetzen. NICHT anfassen:
  # /ycode-Pfade, ycode-* DOM-Ids/Klassen, ycode:// URIs, X-Ycode-* Header, .ycode-Endung,
  # Bezeichner wie YCodeBuilder und der Tab-Wert "ycode-sitemap".
  # Fundstellen suchen: grep -rn 'Ycode\|YCode' app components lib --include=*.tsx --include=*.ts
  "app/(builder)/ycode/components/YCodeBuilderMain.tsx"
  "app/(builder)/ycode/welcome/page.tsx"
  "app/(builder)/ycode/settings/general/page.tsx"
  "app/(builder)/ycode/settings/updates/page.tsx"
  "app/(builder)/ycode/settings/agent/page.tsx"
  "app/(builder)/ycode/settings/email/page.tsx"
  "app/(builder)/ycode/integrations/api/page.tsx"
  "app/(builder)/ycode/integrations/mcp/page.tsx"
  "app/(builder)/ycode/integrations/webhooks/page.tsx"
  "app/(builder)/ycode/integrations/apps/page.tsx"
  "app/(builder)/ycode/integrations/apps/airtable-settings.tsx"
  "app/(builder)/ycode/integrations/apps/static-export-settings.tsx"
  "app/(builder)/ycode/integrations/apps/webflow-settings.tsx"
  "app/(builder)/ycode/oauth/authorize/page.tsx"
  "app/(builder)/ycode/oauth/authorize/ConsentForm.tsx"
  "app/(builder)/ycode/components/IntegrationsContent.tsx"
  "app/(builder)/ycode/components/ImportHtmlDialog.tsx"
  "app/(builder)/ycode/components/ai/ChatComposer.tsx"
  "components/UpdateNotification.tsx"
  "components/project/BackupRestoreDialog.tsx"
  "lib/apps/static-export/writers/github.ts"
  "lib/apps/static-export/types.ts"
  # MCP-Tool-Beschreibungen: der KI-Assistent darf sich nicht als YCode vorstellen.
  "lib/mcp/tools/assets.ts"
  "lib/mcp/tools/collections.ts"
  "lib/mcp/tools/animations.ts"
  "lib/mcp/tools/locales.ts"
  # Demo-Texte der Layout-Bibliothek (Blog-Karten, FAQ) landen beim Einfügen auf Kundenseiten.
  # Re-Apply per Skript, siehe Kopfkommentar der Datei.
  "lib/templates/layouts.ts"

  # White-Label: Platzhalterseiten und Metadaten-Fallbacks ohne veröffentlichte Inhalte.
  "app/(published)/[[...slug]]/page.tsx"
  "app/(site)/_dynamic/page.tsx"
  "app/(site)/ycode/preview/page.tsx"

  # White-Label: "Made in Ycode"-Badge ist aus, solange eine Site ihn nicht ausdrücklich einschaltet
  # (Upstream-Default ist an). Re-Apply: true -> false bzw. ?? true -> ?? false.
  "components/PageRenderer.tsx"
  "app/(site)/not-found.tsx"

  # Verhaltens-/Fehlerkorrekturen des Forks (Details in docs/UPSTREAM-SYNC.md §2a)
  "lib/mcp/tools/publishing.ts"
  "components/MigrationChecker.tsx"
  "app/(builder)/ycode/api/error-page/route.ts"

  # Fork-Doku statt Upstream-Doku (Beitrag, Security-Kontakt, Cursor-Regeln)
  "CONTRIBUTING.md"
  "SECURITY.md"
  ".cursorrules"
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
  "app/(builder)/dev/"
)

# is_divergent <pfad> -> 0, wenn der Pfad in DIVERGENT_FILES steht oder mit einem DIVERGENT_PREFIXES-Eintrag beginnt.
is_divergent() {
  local f="$1" d
  for d in "${DIVERGENT_FILES[@]}"; do [ "$f" = "$d" ] && return 0; done
  for d in "${DIVERGENT_PREFIXES[@]}"; do case "$f" in "$d"*) return 0 ;; esac; done
  return 1
}
