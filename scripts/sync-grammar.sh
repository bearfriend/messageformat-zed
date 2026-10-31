#!/usr/bin/env bash
#
# Keeps everything this extension ships from the grammar repo in sync with the revision that
# extension.toml points at.
#
#   scripts/sync-grammar.sh [REF]       Copy the queries at REF (default: the grammar's
#                                       default branch), pin every grammar's `rev` to that
#                                       commit, and rebuild the VS Code parser (vscode/).
#   scripts/sync-grammar.sh --check     Fail if anything shipped differs from the pinned
#                                       `rev`: the Zed queries, vscode/folds.scm, and
#                                       vscode/grammar.lock (rev + sha256 of the wasm).
#                                       Needs no Docker or Node; CI runs this.
#   --verify-build                      With --check: also rebuild the parser at the pinned
#                                       `rev` and require identical bytes (needs Docker).
#
# Environment:
#   GRAMMAR_REPO      Override the grammar repository (URL or local path), e.g. a local
#                     checkout. Only committed content is used, exactly like Zed does.
#   TREE_SITTER_CMD   How to run the tree-sitter CLI (default: npx -y tree-sitter-cli@^0.27.1).
#                     Building a wasm parser needs Docker or Emscripten.
#
# Zed itself only takes the parser from the pinned `rev`; the .scm files in languages/ are
# copies. The VS Code parser cannot be taken from Zed (its build needs a libc.so that VS Code
# lacks), so vscode/tree-sitter-messageformat.wasm is built here and committed.
set -euo pipefail

cd "$(dirname "$0")/.."

# extension.toml grammar section : query dir in the grammar repo : destination here
GRAMMARS=(
  "messageformat:queries:languages/messageformat"
  "messageformat_message:message/queries:languages/messageformat_message"
)
FILES=(highlights.scm brackets.scm)

# The VS Code artifacts come from the first grammar above.
VSCODE_DIR=vscode
VSCODE_WASM=tree-sitter-messageformat.wasm
VSCODE_FOLDS=folds.scm
VSCODE_LOCK=grammar.lock
VSCODE_SRC_DIR=queries
TREE_SITTER_CMD="${TREE_SITTER_CMD:-npx -y tree-sitter-cli@^0.27.1}"

grammar_field() { # <section> <field>
  sed -n '/^\[grammars\.'"$1"'\]/,/^\[/{s/^'"$2"' *= *"\(.*\)"/\1/p;}' extension.toml
}

sha256_of() { # <file>
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

lock_field() { sed -n 's/^'"$1"' = //p' "$VSCODE_DIR/$VSCODE_LOCK"; }

# build_wasm <grammar clone> <commit> <output file>
build_wasm() {
  git -C "$1" checkout --quiet --detach "$2"
  # shellcheck disable=SC2086  # TREE_SITTER_CMD is meant to be word-split
  (cd "$1" && $TREE_SITTER_CMD build --wasm -o "$3")
}

cli_version() {
  # shellcheck disable=SC2086
  $TREE_SITTER_CMD --version | sed -n 's/^tree-sitter \([0-9][0-9.]*\).*/\1/p' | head -1
}

first_section="${GRAMMARS[0]%%:*}"
repo="${GRAMMAR_REPO:-$(grammar_field "$first_section" repository)}"
[[ -n "$repo" ]] || { echo "could not read [grammars.$first_section] from extension.toml" >&2; exit 2; }

mode=sync
verify_build=0
ref=""
for arg in "$@"; do
  case "$arg" in
    --check) mode=check ;;
    --verify-build) verify_build=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) ref="$arg" ;;
  esac
done
if [[ $verify_build -eq 1 && "$mode" != check ]]; then
  echo "--verify-build only makes sense with --check" >&2; exit 2
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --quiet --no-checkout "$repo" "$tmp/grammar"

if [[ "$mode" == sync ]]; then
  sync_target="$(git -C "$tmp/grammar" rev-parse "${ref:-HEAD}^{commit}")"
  # Build first: if it fails (no Docker, ...) nothing in the repo has been touched yet.
  echo "building $VSCODE_WASM at $sync_target ..."
  build_wasm "$tmp/grammar" "$sync_target" "$tmp/$VSCODE_WASM"
  built_cli_version="$(cli_version)"
  git -C "$tmp/grammar" show "$sync_target:$VSCODE_SRC_DIR/$VSCODE_FOLDS" > "$tmp/$VSCODE_FOLDS"
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

if [[ "$mode" == sync ]]; then
  mkdir -p "$VSCODE_DIR"
  cp "$tmp/$VSCODE_WASM" "$VSCODE_DIR/$VSCODE_WASM"
  cp "$tmp/$VSCODE_FOLDS" "$VSCODE_DIR/$VSCODE_FOLDS"
  {
    echo "# Written by scripts/sync-grammar.sh; checked by scripts/sync-grammar.sh --check."
    echo "rev = $sync_target"
    echo "sha256 = $(sha256_of "$VSCODE_DIR/$VSCODE_WASM")"
    echo "tree-sitter-cli = $built_cli_version"
  } > "$VSCODE_DIR/$VSCODE_LOCK"
  echo "synced queries and VS Code parser, and pinned every grammar to rev = $sync_target"
  echo "next: cargo test, then rebuild the dev extension in Zed (delete grammars/ if a repository URL changed)"
  exit 0
fi

# --check: the VS Code artifacts must belong to the pinned rev.
pinned="$(grammar_field "$first_section" rev)"
target="$(git -C "$tmp/grammar" rev-parse "$pinned^{commit}")"
for f in "$VSCODE_WASM" "$VSCODE_FOLDS" "$VSCODE_LOCK"; do
  if [[ ! -f "$VSCODE_DIR/$f" ]]; then
    echo "error: $VSCODE_DIR/$f is missing; run scripts/sync-grammar.sh" >&2
    status=1
  fi
done

if [[ -f "$VSCODE_DIR/$VSCODE_LOCK" ]]; then
  locked_rev="$(lock_field rev)"
  if [[ "$locked_rev" != "$target" ]]; then
    echo "error: $VSCODE_DIR/$VSCODE_LOCK is for rev ${locked_rev:-<none>}, but extension.toml pins $target; run scripts/sync-grammar.sh" >&2
    status=1
  fi
  if [[ -f "$VSCODE_DIR/$VSCODE_WASM" && "$(sha256_of "$VSCODE_DIR/$VSCODE_WASM")" != "$(lock_field sha256)" ]]; then
    echo "error: $VSCODE_DIR/$VSCODE_WASM does not match the sha256 in $VSCODE_LOCK; run scripts/sync-grammar.sh" >&2
    status=1
  fi
fi
if [[ -f "$VSCODE_DIR/$VSCODE_FOLDS" ]]; then
  git -C "$tmp/grammar" show "$target:$VSCODE_SRC_DIR/$VSCODE_FOLDS" > "$tmp/$VSCODE_FOLDS"
  if ! diff -u "$tmp/$VSCODE_FOLDS" "$VSCODE_DIR/$VSCODE_FOLDS"; then
    echo "error: $VSCODE_DIR/$VSCODE_FOLDS differs from $VSCODE_SRC_DIR/$VSCODE_FOLDS at grammar rev $target" >&2
    status=1
  fi
fi

if [[ $verify_build -eq 1 && $status -eq 0 ]]; then
  build_wasm "$tmp/grammar" "$target" "$tmp/rebuilt.wasm"
  if ! cmp -s "$tmp/rebuilt.wasm" "$VSCODE_DIR/$VSCODE_WASM"; then
    echo "error: rebuilding $VSCODE_WASM at $target gave different bytes than the committed file" >&2
    echo "       (a different tree-sitter-cli or wasm toolchain version can also cause this; locked: $(lock_field tree-sitter-cli))" >&2
    status=1
  fi
fi

[[ $status -eq 0 ]] && echo "ok: shipped queries and VS Code parser match the pinned grammar revs"
exit $status
