#!/usr/bin/env bash
#
# Keeps the query files shipped in this extension in sync with the grammar repo
# that extension.toml points at.
#
#   scripts/sync-grammar.sh [REF]       Copy the queries at REF (default: the grammar's
#                                       default branch) and pin every grammar's `rev` to
#                                       that commit.
#   scripts/sync-grammar.sh --check     Fail if the shipped queries differ from the
#                                       queries at each grammar's currently pinned `rev`.
#
# Environment:
#   GRAMMAR_REPO   Override the grammar repository (URL or local path), e.g. a local
#                  checkout. Only committed content is used, exactly like Zed does.
#
# Zed itself only takes the parser from the pinned `rev`; the .scm files below are
# copies that have to be refreshed by hand (or by this script).
set -euo pipefail

cd "$(dirname "$0")/.."

# extension.toml grammar section : query dir in the grammar repo : destination here
GRAMMARS=(
  "messageformat:queries:languages/messageformat"
  "messageformat_message:message/queries:languages/messageformat_message"
)
FILES=(highlights.scm brackets.scm)

grammar_field() { # <section> <field>
  sed -n '/^\[grammars\.'"$1"'\]/,/^\[/{s/^'"$2"' *= *"\(.*\)"/\1/p;}' extension.toml
}

first_section="${GRAMMARS[0]%%:*}"
repo="${GRAMMAR_REPO:-$(grammar_field "$first_section" repository)}"
[[ -n "$repo" ]] || { echo "could not read [grammars.$first_section] from extension.toml" >&2; exit 2; }

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

if [[ "$mode" == sync ]]; then
  sync_target="$(git -C "$tmp/grammar" rev-parse "${ref:-HEAD}^{commit}")"
fi

status=0
for entry in "${GRAMMARS[@]}"; do
  IFS=: read -r section src_dir dest_dir <<< "$entry"
  if [[ "$mode" == check ]]; then
    pinned="$(grammar_field "$section" rev)"
    [[ -n "$pinned" ]] || { echo "could not read rev for [grammars.$section] from extension.toml" >&2; exit 2; }
    target="$(git -C "$tmp/grammar" rev-parse "$pinned^{commit}")"
  else
    target="$sync_target"
  fi

  for f in "${FILES[@]}"; do
    git -C "$tmp/grammar" show "$target:$src_dir/$f" > "$tmp/$section.$f"
    if [[ "$mode" == check ]]; then
      if ! diff -u "$tmp/$section.$f" "$dest_dir/$f"; then
        echo "error: $dest_dir/$f differs from $src_dir/$f at grammar rev $target" >&2
        status=1
      fi
    else
      cp "$tmp/$section.$f" "$dest_dir/$f"
    fi
  done

  if [[ "$mode" == sync ]]; then
    sed -i.bak '/^\[grammars\.'"$section"'\]/,/^\[/s/^rev = ".*"/rev = "'"$target"'"/' extension.toml
    rm -f extension.toml.bak
  fi
done

if [[ "$mode" == check ]]; then
  [[ $status -eq 0 ]] && echo "ok: shipped queries match the pinned grammar revs"
  exit $status
fi

echo "synced queries and pinned every grammar to rev = $sync_target"
echo "next: cargo test, then rebuild the dev extension in Zed (delete grammars/ if a repository URL changed)"
