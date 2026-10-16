# MessageFormat for Zed

Syntax highlighting and bracket matching for [ICU MessageFormat](https://unicode-org.github.io/icu/userguide/format_parse/messages/) files in [Zed](https://zed.dev), powered by [tree-sitter-messageformat](https://github.com/bearfriend/tree-sitter-messageformat).

Two languages are included:

| Language | Use | Matches |
| --- | --- | --- |
| **MessageFormat** | Resource files: `key: "message"` entries, optionally wrapped in `export default { ... };` | `.mf`, `.mf.js`, and the legacy `.msg`, `.messages` |
| **MessageFormat Message** | A single bare message such as `Hello {name}!`, meant for embedding inside other files | Markdown fences ```` ```messageformat-message ````; no file extensions |

## Installing as a dev extension

1. Clone this repository.
2. In Zed, run **zed: install dev extension** and select **this repository's root directory** (the folder containing `extension.toml`).

Rust must be installed via `rustup`; Zed compiles the extension and the grammar for you.

## How the grammar gets here

```
tree-sitter-messageformat (grammar repo)             messageformat-zed (this repo)
  grammar.js, src/parser.c      ── pinned by ───▶    extension.toml  [grammars.messageformat]
  message/grammar.js,                                  repository = "https://github.com/.../tree-sitter-messageformat"
  message/src/parser.c          ── pinned by ───▶      rev        = "<full commit SHA>"
                                                     extension.toml  [grammars.messageformat_message]
                                                       (same repository and rev, path = "message")
  queries/{highlights,brackets}.scm
                                ── copied by ───▶    languages/messageformat/
  message/queries/{highlights,brackets}.scm
                                ── copied by ───▶    languages/messageformat_message/
```

- **The parsers** are not stored here. Zed clones `repository` into `grammars/<name>/`, checks out `rev` and compiles `src/parser.c` (under `path`, if set) to wasm. Both grammars come from the same repository and are pinned to the same commit.
- **The queries are copies.** Zed does not read queries from the grammar repo, so the `.scm` files under `languages/` must match the grammar repo at the pinned `rev`. Never edit them here; change them in the grammar repo and sync.
- Each `languages/*/config.toml` is owned by this repo.
- The second grammar's key must be `messageformat_message` (snake case): Zed looks up the wasm export `tree_sitter_messageformat_message`.

## Embedding in other languages (JS, HTML, Java, Kotlin, Swift, ...)

This extension registers the **MessageFormat Message** language so that hosts *can* inject it, but **a Zed extension cannot add injections to a built-in language** ([zed#8795](https://github.com/zed-industries/zed/issues/8795), [zed#65382](https://github.com/zed-industries/zed/issues/65382)). Zed reads injections only from the host language's own `injections.scm`. So today:

- `.mf` / `.mf.js` / `.msg` / `.messages` files are highlighted as resource files.
- Markdown fences tagged `messageformat-message` use the bare-message language (and plain `messageformat` fences use the resource-file language). *Resolution logic is from Zed's source; I haven't confirmed the rendering in Zed itself.*
- MessageFormat strings inside `.js`, `.html`, `.java`, ... are **not** highlighted yet. That needs the host's `injections.scm` to change in Zed itself.

The language answers to the names `messageformat-message` and `messageformat_message` (Zed resolves injection and fence names by language name or path suffix), so an upstream injection written as `(#set! injection.language "messageformat_message")` will resolve to it. Zed leaves an injection of a language that isn't installed pending, and re-parses once it appears, so such upstream rules would be inert for users without this extension.

The ready-to-use host queries (JavaScript/TypeScript/TSX, JSON, HTML, Java, Kotlin, Swift) live in the [grammar repo](https://github.com/bearfriend/tree-sitter-messageformat#embedding-in-other-languages) for Neovim, Helix and other tree-sitter tools, and as the basis for proposing them to Zed.

## Updating the grammar

1. Make and test your grammar changes in the grammar repo, commit, and **push** (Zed can only fetch pushed commits).
2. Here, run:

   ```bash
   scripts/sync-grammar.sh            # copy queries from the grammar's default branch, pin rev to its HEAD
   scripts/sync-grammar.sh <ref>      # ...or from a specific branch/tag/SHA
   cargo test
   ```

3. Commit `extension.toml` and `languages/*/*.scm` together.
4. In Zed run **zed: rebuild dev extension** and open `test/sample.msg`.

`scripts/sync-grammar.sh --check` verifies that the shipped queries equal the queries at each grammar's pinned `rev`; CI runs it on every push. Set `GRAMMAR_REPO=/path/to/local/checkout` to sync from a local clone (only committed content is used).

If you ever change the grammar `repository` URL, delete `grammars/` so Zed re-clones from the new origin.

## Development

```bash
cargo test                          # manifest, config and query consistency checks
cargo check --target wasm32-wasip1  # the extension itself builds as wasm
```

When `../tree-sitter-messageformat` is checked out next to this repo, the tests additionally verify that the queries only use node types that exist in each grammar, that they match the sibling's queries, and that every `injection.language` the grammar repo's host queries emit resolves to the message language.

Manual test files:
- `test/sample.msg` &mdash; open in Zed to check highlighting by eye
- `test/manual/messages.msg` &mdash; larger sample in module form
- `test/injection-test.mf.js` &mdash; JS sample of MessageFormat inside another language. Zed can't inject it yet (see above); the automated injection tests are in the grammar repo (`test/host-injections/`)

Zed's log is at `~/Library/Logs/Zed/Zed.log` (macOS) if the extension fails to install.

## Publishing

Publishing goes through the [zed-industries/extensions](https://github.com/zed-industries/extensions) registry; see Zed's [extension docs](https://zed.dev/docs/extensions/developing-extensions) for the current requirements. Before submitting, make sure both repositories are pushed publicly, `extension.toml` `rev` is a pushed commit, and `scripts/sync-grammar.sh --check` passes.

## License

MIT &copy; 2026 Danny Gleckler. See [LICENSE](LICENSE).
