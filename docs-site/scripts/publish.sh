#!/usr/bin/env bash
# Build the static docs site and copy out/ into the nextcli-docs repo.
# Cloudflare Pages serves that repo with no build step.
#
#   ./scripts/publish.sh
#   NEXTCLI_DOCS_DIR=/path/to/nextcli-docs ./scripts/publish.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${NEXTCLI_DOCS_DIR:-$(cd "$ROOT/../.." && pwd)/nextcli-docs}"
LIMIT=$((25 * 1024 * 1024))

cd "$ROOT"
npm ci
npm run build

for required in sitemap.xml robots.txt _redirects; do
  if [[ ! -f "$ROOT/out/$required" ]]; then
    echo "build did not produce out/$required" >&2
    exit 1
  fi
done

too_big=0
while IFS= read -r -d '' file; do
  size=$(stat -f%z "$file")
  if [[ "$size" -gt "$LIMIT" ]]; then
    echo "over 25 MiB: $file ($size bytes)" >&2
    too_big=1
  fi
done < <(find "$ROOT/out" -type f -print0)
if [[ "$too_big" -ne 0 ]]; then
  exit 1
fi

mkdir -p "$DEST"
rsync -a --delete --exclude .git --exclude README.md --exclude .gitignore --exclude .assetsignore "$ROOT/out/" "$DEST/"

if git -C "$DEST" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$DEST" status --short
else
  echo "Copied the build to $DEST."
  echo "That folder is not a git repo yet. Review it, then:"
  echo "  cd \"$DEST\""
  echo "  git init && git add . && git commit -m \"feat: publish docs.nextcli.dev\""
  echo "  gh repo create nextcli-dev/nextcli-docs --private --source=. --remote=origin --push"
fi
