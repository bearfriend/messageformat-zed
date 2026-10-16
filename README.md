# MessageFormat for Zed

Syntax highlighting and bracket matching for [ICU MessageFormat](https://unicode-org.github.io/icu/userguide/format_parse/messages/) files in [Zed](https://zed.dev), powered by [tree-sitter-messageformat](https://github.com/bearfriend/tree-sitter-messageformat).

Recognised file suffixes: `.msg`, `.messages`, `.mf`, `.mf.js`, `.mf.json`.

## Installing as a dev extension

1. Clone this repository.
2. In Zed, run **zed: install dev extension** and select **this repository's root directory** (the folder containing `extension.toml`).

Rust must be installed via `rustup`; Zed compiles the extension and the grammar for you.

## How the grammar gets here

```
tree-sitter-messageformat (grammar repo)        messageformat-zed (this repo)
  grammar.js, src/parser.c  ── pinned by ───▶   extension.toml  [grammars.messageformat]
                                                  repository = "https://github.com/.../tree-sitter-messageformat"
                                                  rev        = "<full commit SHA>"
  queries/highlights.scm    ── copied by ───▶   languages/messageformat/highlights.scm
  queries/brackets.scm      ── copied by ───▶   languages/messageformat/brackets.scm
```

- **The parser** is not stored here. Zed clones `repository` into `grammars/messageformat/` (gitignored), checks out `rev` and compiles `src/parser.c` to wasm.
- **The queries are copies.** Zed does not read queries from the grammar repo, so `highlights.scm` and `brackets.scm` in `languages/messageformat/` must match the grammar repo at the pinned `rev`. Never edit them here; change them in the grammar repo and sync.
- `languages/messageformat/config.toml` is owned by this repo.

## Updating the grammar

1. Make and test your grammar changes in the grammar repo, commit, and **push** (Zed can only fetch pushed commits).
2. Here, run:

   ```bash
   scripts/sync-grammar.sh            # copy queries from the grammar's default branch, pin rev to its HEAD
   scripts/sync-grammar.sh <ref>      # ...or from a specific branch/tag/SHA
   cargo test
   ```

3. Commit `extension.toml` and `languages/messageformat/*.scm` together.
4. In Zed run **zed: rebuild dev extension** and open `test/sample.msg`.

`scripts/sync-grammar.sh --check` verifies that the shipped queries equal the queries at the pinned `rev`; CI runs it on every push. Set `GRAMMAR_REPO=/path/to/local/checkout` to sync from a local clone (only committed content is used).

If you ever change the grammar `repository` URL, delete `grammars/messageformat/` so Zed re-clones from the new origin.

## Development

```bash
cargo test                          # manifest, config and query consistency checks
cargo check --target wasm32-wasip1  # the extension itself builds as wasm
```

When `../tree-sitter-messageformat` is checked out next to this repo, the tests additionally verify that the queries only use node types that exist in the grammar and that they match the sibling's queries.

Manual test files:
- `test/sample.msg` &mdash; open in Zed to check highlighting by eye
- `test/manual/messages.msg` &mdash; larger sample in module form
- `test/injection-test.js` &mdash; placeholder for testing MessageFormat injection inside other file types (not yet automated)

Zed's log is at `~/Library/Logs/Zed/Zed.log` (macOS) if the extension fails to install.

## Publishing

Publishing goes through the [zed-industries/extensions](https://github.com/zed-industries/extensions) registry; see Zed's [extension docs](https://zed.dev/docs/extensions/developing-extensions) for the current requirements. Before submitting, make sure both repositories are pushed publicly, `extension.toml` `rev` is a pushed commit, and `scripts/sync-grammar.sh --check` passes.

## License

MIT &copy; 2026 Danny Gleckler. See [LICENSE](LICENSE).
