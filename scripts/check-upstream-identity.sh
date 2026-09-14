#!/usr/bin/env bash
#
# Webwow: Identitätsprüfung gegen Upstream ycode.
#
# Jede Datei, die NICHT in scripts/sync-lists.sh (DIVERGENT_FILES / DIVERGENT_PREFIXES) steht,
# muss byte-identisch mit Upstream sein — sonst würde scripts/sync-upstream.sh --take-upstream
# sie beim nächsten Sync mit der Upstream-Version überschreiben (docs/UPSTREAM-SYNC.md §2).
#
# Aufruf:
#   scripts/check-upstream-identity.sh                      # gegen den Git-Ref upstream/main
#   scripts/check-upstream-identity.sh upstream/v1.31.0     # anderer Git-Ref (Tag, Branch, Commit)
#   scripts/check-upstream-identity.sh /pfad/zum/ycode      # lokaler Upstream-Checkout (Verzeichnis)
#
# Exit-Code 0: nur gelistete Dateien weichen ab. Exit-Code 1: ungelistete Abweichungen (werden ausgegeben).
# Verglichen werden alle versionierten Dateien plus untracked, nicht ignorierte Dateien des Arbeitsbaums.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "Kein Git-Repository." >&2; exit 2; }
cd "$ROOT"
# shellcheck source=scripts/sync-lists.sh
source "$ROOT/scripts/sync-lists.sh"

TARGET="${1:-upstream/main}"

# Einträge "<Status>\t<Pfad>" mit Status M (geändert), A (nur in Webwow), D (nur in Upstream).
ENTRIES=()

if [ -d "$TARGET" ]; then
  UP="$(cd "$TARGET" && pwd)"
  if git -C "$UP" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    mapfile -t UP_FILES < <(git -C "$UP" -c core.quotePath=false ls-files)
  else
    mapfile -t UP_FILES < <(cd "$UP" && find . -type f -not -path './.git/*' -not -path './node_modules/*' -not -path './.next/*' | sed 's#^\./##')
  fi
  mapfile -t OUR_FILES < <(git -c core.quotePath=false ls-files -c -o --exclude-standard)
  mapfile -t ALL_FILES < <(printf '%s\n' "${UP_FILES[@]}" "${OUR_FILES[@]}" | LC_ALL=C sort -u)
  for f in "${ALL_FILES[@]}"; do
    [ -n "$f" ] || continue
    if [ -f "$UP/$f" ] && [ -f "$f" ]; then
      cmp -s "$UP/$f" "$f" || ENTRIES+=("M	$f")
    elif [ -f "$UP/$f" ]; then
      ENTRIES+=("D	$f")
    elif [ -f "$f" ]; then
      ENTRIES+=("A	$f")
    fi
  done
  LABEL="Verzeichnis $UP"
else
  git rev-parse --verify --quiet "$TARGET^{commit}" >/dev/null \
    || { echo "'$TARGET' ist weder ein Verzeichnis noch ein Git-Ref (upstream fehlt? -> npm run sync:upstream)." >&2; exit 2; }
  while IFS=$'\t' read -r status f; do
    [ -n "${f:-}" ] || continue
    case "$status" in
      M*|T*) ENTRIES+=("M	$f") ;;
      A*) ENTRIES+=("A	$f") ;;
      D*) ENTRIES+=("D	$f") ;;
      *) ENTRIES+=("M	$f") ;;
    esac
  done < <(git -c core.quotePath=false diff --name-status --no-renames "$TARGET" -- .)
  while IFS= read -r f; do
    [ -n "$f" ] && ENTRIES+=("A	$f")
  done < <(git -c core.quotePath=false ls-files -o --exclude-standard)
  LABEL="Git-Ref $TARGET ($(git rev-parse --short "$TARGET"))"
fi

EXPECTED=()
UNEXPECTED=()
for e in "${ENTRIES[@]}"; do
  f="${e#*	}"
  if is_divergent "$f"; then EXPECTED+=("$e"); else UNEXPECTED+=("$e"); fi
done

echo "Upstream-Identität gegen $LABEL"
echo "  Abweichende Dateien gesamt: ${#ENTRIES[@]} (gelistet: ${#EXPECTED[@]}, ungelistet: ${#UNEXPECTED[@]})"
if [ "${#UNEXPECTED[@]}" -gt 0 ]; then
  echo
  echo "FEHLER: Dateien außerhalb von DIVERGENT_FILES/DIVERGENT_PREFIXES weichen von Upstream ab"
  echo "        (M = geändert, A = nur in Webwow, D = nur in Upstream):"
  printf '  %s\n' "${UNEXPECTED[@]}"
  echo
  echo "Entweder Datei mit Upstream abgleichen (git checkout $TARGET -- <datei>) oder — wenn die"
  echo "Abweichung gewollt ist — in scripts/sync-lists.sh eintragen und in docs/UPSTREAM-SYNC.md §2 dokumentieren."
  exit 1
fi
echo "  OK: alle Abweichungen sind in scripts/sync-lists.sh gelistet."
