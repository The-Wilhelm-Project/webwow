#!/usr/bin/env bash
#
# Webwow: Upstream-Sync-Helfer für ycode (https://github.com/ycode/ycode).
#
# Aufruf:
#   scripts/sync-upstream.sh                 # upstream holen, Stand anzeigen (read-only)
#   scripts/sync-upstream.sh --merge         # zusätzlich: git merge --no-commit upstream/main
#   scripts/sync-upstream.sh --merge --take-upstream
#                                            # Konflikte in NICHT-divergenten Dateien automatisch
#                                            # mit der Upstream-Version lösen (checkout --theirs + add)
#   scripts/sync-upstream.sh --take-upstream # dasselbe für einen bereits laufenden Merge
#   scripts/sync-upstream.sh --ref upstream/v1.31.0   # anderen Upstream-Ref mergen
#
# Das Skript committet NIE. Nach --merge prüfen, testen, dann selbst `git commit`.
# Hintergrund und Checkliste: docs/UPSTREAM-SYNC.md
set -euo pipefail

UPSTREAM_URL="https://github.com/ycode/ycode"
UPSTREAM_REMOTE="upstream"
UPSTREAM_REF="${UPSTREAM_REMOTE}/main"
DO_MERGE=0
TAKE_UPSTREAM=0

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
  "app/storage/"
  "database/migrations/00000000000000_"
  "database/migrations/99999999999999_"
  "database/migrations/20260324000001_create_webflow_imports_table"
  "lib/services/webflowImportService"
  "lib/repositories/webflowImportRepository"
  "components/project/WebflowImportDialog"
  "docs/"
  "scripts/sync-upstream.sh"
  ".github/"
)

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --merge) DO_MERGE=1 ;;
    --take-upstream) TAKE_UPSTREAM=1 ;;
    --ref) shift; UPSTREAM_REF="${1:-}"; [ -n "$UPSTREAM_REF" ] || { echo "--ref braucht einen Wert" >&2; exit 2; } ;;
    -h|--help) usage 0 ;;
    *) echo "Unbekannte Option: $1" >&2; usage 2 ;;
  esac
  shift
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }

is_divergent() {
  local f="$1" d
  for d in "${DIVERGENT_FILES[@]}"; do [ "$f" = "$d" ] && return 0; done
  for d in "${DIVERGENT_PREFIXES[@]}"; do case "$f" in "$d"*) return 0 ;; esac; done
  return 1
}

# --- Repo-Root ---------------------------------------------------------------
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "Kein Git-Repository." >&2; exit 1; }
cd "$ROOT"

# --- Remote sicherstellen + fetch -------------------------------------------
if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  bold "Remote '$UPSTREAM_REMOTE' fehlt - wird angelegt: $UPSTREAM_URL"
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi
bold "Hole $UPSTREAM_REMOTE ..."
git fetch --quiet --tags "$UPSTREAM_REMOTE"

git rev-parse --verify --quiet "$UPSTREAM_REF^{commit}" >/dev/null || { echo "Ref '$UPSTREAM_REF' existiert nicht." >&2; exit 1; }

# --- Status ------------------------------------------------------------------
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
MERGE_BASE="$(git merge-base HEAD "$UPSTREAM_REF")"
AHEAD="$(git rev-list --count HEAD.."$UPSTREAM_REF")"
LOCAL_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo '?')"
UPSTREAM_VERSION="$(git show "$UPSTREAM_REF:package.json" 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version" 2>/dev/null || echo '?')"

echo
bold "Stand"
info "Branch:            $BRANCH"
info "Lokale Version:    $LOCAL_VERSION"
info "Upstream-Ref:      $UPSTREAM_REF ($(git rev-parse --short "$UPSTREAM_REF")) - ycode $UPSTREAM_VERSION"
info "Merge-Base:        $(git rev-parse --short "$MERGE_BASE")"
info "Upstream-Commits seit Merge-Base: $AHEAD"
if [ "$AHEAD" -gt 0 ]; then
  echo
  bold "Neueste Upstream-Commits (max. 30):"
  git log --oneline --no-decorate --max-count=30 HEAD.."$UPSTREAM_REF" | sed 's/^/  /'
  [ "$AHEAD" -gt 30 ] && info "... ($((AHEAD - 30)) weitere: git log --oneline HEAD..$UPSTREAM_REF)"
  echo
  bold "Upstream-Änderungen an Webwow-divergenten Dateien (von Hand nachziehen):"
  changed=0
  for f in "${DIVERGENT_FILES[@]}"; do
    if ! git diff --quiet "$MERGE_BASE" "$UPSTREAM_REF" -- "$f" 2>/dev/null; then info "$f"; changed=1; fi
  done
  [ "$changed" -eq 0 ] && info "(keine)"
  echo
  bold "Neue Upstream-Migrationen:"
  git diff --name-only --diff-filter=A "$MERGE_BASE" "$UPSTREAM_REF" -- database/migrations | sed 's/^/  /' || true
  echo
  bold "Upstream-Treffer auf Supabase-APIs, die der Shim eventuell noch nicht kann (grob):"
  git diff "$MERGE_BASE" "$UPSTREAM_REF" -- app lib 2>/dev/null \
    | grep -E '^\+' | grep -E '\.(rpc|channel|storage\.from|auth\.admin\.[a-zA-Z]+)\(' \
    | sed 's/^+//' | sort -u | head -40 | sed 's/^/  /' || true
fi

# --- Merge ---------------------------------------------------------------------
MERGE_IN_PROGRESS=0
[ -f "$(git rev-parse --git-dir)/MERGE_HEAD" ] && MERGE_IN_PROGRESS=1

if [ "$DO_MERGE" -eq 1 ]; then
  if [ "$MERGE_IN_PROGRESS" -eq 1 ]; then
    echo "Es läuft bereits ein Merge (MERGE_HEAD vorhanden). Erst abschließen oder 'git merge --abort'." >&2
    exit 1
  fi
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Arbeitsbaum ist nicht sauber - bitte committen oder stashen, bevor gemergt wird." >&2
    exit 1
  fi
  if [ "$AHEAD" -eq 0 ]; then
    bold "Nichts zu mergen - Upstream ist bereits enthalten."
    exit 0
  fi
  echo
  bold "git merge --no-commit --no-ff $UPSTREAM_REF"
  if git merge --no-commit --no-ff "$UPSTREAM_REF"; then
    info "Merge ohne Konflikte (noch nicht committet)."
  else
    info "Merge mit Konflikten - siehe unten."
  fi
  MERGE_IN_PROGRESS=1
fi

# --- Konflikte einordnen ------------------------------------------------------
if [ "$MERGE_IN_PROGRESS" -eq 1 ]; then
  mapfile -t CONFLICTS < <(git diff --name-only --diff-filter=U)
  if [ "${#CONFLICTS[@]}" -eq 0 ]; then
    echo
    bold "Keine Konflikte offen."
  else
    HAND=()
    UPSTREAM=()
    for f in "${CONFLICTS[@]}"; do
      if is_divergent "$f"; then HAND+=("$f"); else UPSTREAM+=("$f"); fi
    done
    echo
    bold "Konflikte - Webwow-divergent (von Hand lösen, Upstream-Änderung + Webwow-Anpassung zusammenführen):"
    if [ "${#HAND[@]}" -eq 0 ]; then info "(keine)"; else printf '  %s\n' "${HAND[@]}"; fi
    echo
    bold "Konflikte - sollten Upstream übernehmen (git checkout --theirs):"
    if [ "${#UPSTREAM[@]}" -eq 0 ]; then info "(keine)"; else printf '  %s\n' "${UPSTREAM[@]}"; fi

    if [ "$TAKE_UPSTREAM" -eq 1 ] && [ "${#UPSTREAM[@]}" -gt 0 ]; then
      echo
      bold "Löse nicht-divergente Konflikte mit der Upstream-Version auf ..."
      for f in "${UPSTREAM[@]}"; do
        if git checkout --theirs -- "$f" 2>/dev/null; then
          git add -- "$f"
          info "upstream:  $f"
        elif ! git cat-file -e "$UPSTREAM_REF:$f" 2>/dev/null; then
          # Upstream hat die Datei gelöscht (delete/modify-Konflikt) -> auch hier löschen.
          git rm --quiet -- "$f"
          info "gelöscht:  $f (in Upstream entfernt)"
        else
          info "OFFEN:     $f (konnte nicht automatisch gelöst werden - bitte von Hand)"
        fi
      done
    elif [ "$TAKE_UPSTREAM" -eq 1 ]; then
      info "(nichts automatisch zu lösen)"
    fi

    echo
    mapfile -t REMAINING < <(git diff --name-only --diff-filter=U)
    bold "Noch offene Konflikte: ${#REMAINING[@]}"
    printf '  %s\n' "${REMAINING[@]}"
  fi
elif [ "$TAKE_UPSTREAM" -eq 1 ]; then
  echo "--take-upstream ohne laufenden Merge: bitte zusammen mit --merge aufrufen." >&2
  exit 1
fi

# --- Erinnerung --------------------------------------------------------------
cat <<'REMINDER'

Nach dem Merge (Details: docs/UPSTREAM-SYNC.md):
  1. Divergente Dateien von Hand zusammenführen; `git diff upstream/main -- <datei>` zeigt, was Webwow ändert.
  2. Upstream-Diff auf neue Supabase-Aufrufe prüfen (rpc, storage, auth.admin, channel) -> lib/webwow erweitern.
  3. Neue Upstream-Migrationen auf `auth.`/`storage.`-Referenzen prüfen -> Bootstrap-Migration erweitern.
  4. Neue env-Vars aus upstream .env.example nach .env.example / docker-compose.yml übernehmen.
  5. npm ci && npm run type-check && npm run lint && npm test && npm run build
  6. Migrationen auf einer Test-DB: DATABASE_URL=... npm run migrate:latest (leere DB UND Kopie einer Produktiv-DB)
  7. Smoke-Test: Login, Seite bearbeiten, Asset hochladen, Publish, Webflow-ZIP-Import, /webwow -> /ycode Redirect.
  8. package.json version auf <ycode-version>-webwow.1 setzen, CHANGELOG.md ergänzen, dann committen.
REMINDER
