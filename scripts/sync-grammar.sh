#!/usr/bin/env bash
#
# Keeps the query files shipped in this extension in sync with the grammar repo
# that extension.toml points at.
#
#   scripts/sync-grammar.sh [REF]       Copy the queries at REF (default: the grammar's
#                                       default branch) and pin `rev` to that commit.
#   scripts/sync-grammar.sh --check     Fail if the shipped queries differ from the
#                                       queries at the currently pinned `rev`.
#
# Environment:
#   GRAMMAR_REPO   Override the grammar repository (URL or local path), e.g. a local
#                  checkout. Only committed content is used, exactly like Zed does.
#
# Zed itself only takes the parser from the pinned `rev`; the .scm files below are
# copies that have to be refreshed by hand (or by this script).
set -euo pipefail

cd "$(dirname "$0")/.."

FILES=(highlights.scm brackets.scm)
SRC_DIR=queries
DEST_DIR=languages/messageformat

grammar_field() {
  sed -n '/^\[grammars\.messageformat\]/,/^\[/{s/^'"$1"' *= *"\(.*\)"/\1/p;}' extension.toml
}

repo="${GRAMMAR_REPO:-$(grammar_field repository)}"
pinned="$(grammar_field rev)"
[[ -n "$repo" && -n "$pinned" ]] || { echo "could not read [grammars.messageformat] from extension.toml" >&2; exit 2; }

mode=sync
ref=""
case "${1:-}" in
  --check) mode=check ;;
  -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
  "") ;;
  *) ref="$1" ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --quiet --no-checkout "$repo" "$tmp/grammar"

if [[ "$mode" == check ]]; then
  target="$pinned"
else
  target="$(git -C "$tmp/grammar" rev-parse "${ref:-HEAD}^{commit}")"
fi
target="$(git -C "$tmp/grammar" rev-parse "$target^{commit}")"

status=0
for f in "${FILES[@]}"; do
  git -C "$tmp/grammar" show "$target:$SRC_DIR/$f" > "$tmp/$f"
  if [[ "$mode" == check ]]; then
    if ! diff -u "$tmp/$f" "$DEST_DIR/$f"; then
      echo "error: $DEST_DIR/$f differs from $SRC_DIR/$f at grammar rev $target" >&2
      status=1
    fi
  else
    cp "$tmp/$f" "$DEST_DIR/$f"
  fi
done

if [[ "$mode" == check ]]; then
  [[ $status -eq 0 ]] && echo "ok: queries match grammar rev $target"
  exit $status
fi

sed -i.bak '/^\[grammars\.messageformat\]/,/^\[/s/^rev = ".*"/rev = "'"$target"'"/' extension.toml
rm -f extension.toml.bak
echo "synced queries and pinned rev = $target"
echo "next: cargo test, then rebuild the dev extension in Zed (delete grammars/messageformat/ if the repository URL changed)"
